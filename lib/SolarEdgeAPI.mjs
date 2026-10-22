import fetch from 'node-fetch';
import signIn from './CognitoSRP.mjs';

export default class SolarEdgeAPI {

  // node-fetch has no default timeout. Without one a half-open socket (a
  // dropped connection that never RSTs) leaves the request pending forever,
  // which silently wedges the pollers.
  static REQUEST_TIMEOUT = 1000 * 30; // 30 seconds

  cookies = [];
  headers = {
    'User-Agent': 'SolarEdge/14 CFNetwork/1568.200.51 Darwin/24.1.0',
    'CLIENT-VERSION': '3.12',
  };

  isLoggedIn() {
    return this.cookies.length > 0;
  }

  async request(url, options = {}) {
    const method = options.method ?? 'GET';
    const start = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SolarEdgeAPI.REQUEST_TIMEOUT);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      // Buffer the body here, while the abort timer is still armed. fetch()
      // resolves as soon as the headers arrive, so reading the body outside
      // this window is the other way a request can hang indefinitely.
      const body = await res.text();

      console.log(`[SolarEdgeAPI] ${method} ${url} -> ${res.status} (${Date.now() - start}ms, ${Buffer.byteLength(body)}B)`);

      // A 401 on a cookie-authenticated request means the session expired.
      // Drop the cookies so isLoggedIn() reports false and the caller logs in
      // again on the next tick, instead of replaying a dead session forever.
      if (res.status === 401 && options.headers?.Cookie) {
        this.cookies = [];
      }

      // The body is already consumed, so hand callers the buffered copy.
      res.text = async () => body;
      res.json = async () => JSON.parse(body);

      return res;
    } catch (err) {
      // A connection that fails over both IPv6 and IPv4 surfaces as an
      // AggregateError with an empty message; the code is the useful part.
      const reason = err.name === 'AbortError'
        ? `timed out after ${SolarEdgeAPI.REQUEST_TIMEOUT}ms`
        : [err.message, err.code && `[${err.code}]`].filter(Boolean).join(' ') || err.name;

      console.log(`[SolarEdgeAPI] ${method} ${url} -> failed (${Date.now() - start}ms, ${reason})`);

      if (err.name === 'AbortError') {
        throw new Error(`Request ${reason}`);
      }

      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Logs in unless the session is live. Everyone sharing this instance (the
  // devices on a site, through SolarEdgeSitePoller) shares the one login:
  // while it's in flight, other callers wait for it rather than starting
  // their own.
  async ensureLoggedIn({ username, password }) {
    if (this.isLoggedIn()) return;

    this.loggingIn ??= this.login({ username, password }).finally(() => {
      this.loggingIn = null;
    });
    await this.loggingIn;
  }

  async login({
    username,
    password,
  }) {
    // The old /solaredge-apigw/api/login endpoint now answers 410 Gone.
    // Sign-in goes through Cognito; the monitoring site then trades the
    // tokens for its own session cookies.
    let tokens;
    try {
      tokens = await signIn({ username, password });
    } catch (err) {
      if (err.type === 'NotAuthorizedException' || err.type === 'UserNotFoundException') {
        throw new Error('Invalid e-mail and/or password.');
      }
      throw err;
    }

    const res = await this.request('https://monitoring.solaredge.com/services/auth/token?legacy=false', {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id_token: tokens.IdToken,
        access_token: tokens.AccessToken,
        refresh_token: tokens.RefreshToken,
        expires_in: tokens.ExpiresIn,
        token_type: tokens.TokenType,
      }),
    });

    if (!res.ok) {
      throw new Error(`Login failed (${res.status})`);
    }

    const cookies = res.headers.raw()['set-cookie'] ?? [];
    this.cookies = cookies
      .map((cookie) => cookie.split(';')[0])
      .filter((cookie) => !cookie.startsWith('__cf_bm='));

    if (!this.isLoggedIn()) {
      throw new Error('Login failed (no session)');
    }
  }

  async getSites() {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await this.request('https://monitoring.solaredge.com/services/m/so/sites/', {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
      },
    });

    if (res.status === 401) {
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      throw new Error(res.statusText ?? 'Error Getting Sites');
    }

    const { sites } = await res.json();
    return sites;
  }

  async getCapabilities({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await this.request(`https://monitoring.solaredge.com/services/m/so/dashboard/site/${siteId}/details`, {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
      },
    });

    if (res.status === 401) {
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: res.statusText,
        messages: ['Unknown Error'],
      }));
      throw new Error(error?.code ?? 'Error Getting Site Capabilities');
    }

    const capabilities = await res.json();
    return capabilities;
  }

  async getSitePowerflow({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await this.request(`https://monitoring.solaredge.com/services/m/so/dashboard/v2/site/${siteId}/powerflow/latest?components=consumption%2Cgrid%2Cstorage%2Cev-charger`, {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
      },
    });

    if (res.status === 401) {
      this.cookies = [];
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: res.statusText,
        messages: ['Unknown Error'],
      }));
      throw new Error(error?.code ?? 'Error Getting Site Powerflow');
    }

    const powerflow = await res.json();
    return powerflow;
  }

  async getSiteEnergyOverview({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await this.request(`https://monitoring.solaredge.com/services/m/so/dashboard/site/${siteId}/energyOverview`, {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
      },
    });

    if (res.status === 401) {
      this.cookies = [];
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: res.statusText,
        messages: ['Unknown Error'],
      }));
      throw new Error(error?.code ?? 'Error Getting Site Energy Overview');
    }

    const energyOverview = await res.json();
    return energyOverview;
  }

  async getSiteDataAvailability({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await this.request(`https://monitoring.solaredge.com/services/dashboard/data-availability/sites/${siteId}`, {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
      },
    });

    if (res.status === 401) {
      this.cookies = [];
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: res.statusText,
        messages: ['Unknown Error'],
      }));
      throw new Error(error?.code ?? 'Error Getting Site Data Availability');
    }

    const dataAvailability = await res.json();
    return dataAvailability;
  }

  async getSiteEnergySummary(siteId, timeRange = 'LIFETIME') {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const dataAvailability = await this.getSiteDataAvailability({ siteId });

    if (!dataAvailability.consumptionDataAvailableFrom?.length || !dataAvailability.lastUpdateTime?.length) {
      throw new Error('No data availability');
    }

    let start = '';
    if (timeRange === 'LIFETIME') {
      start = dataAvailability.consumptionDataAvailableFrom.substring(0, 10);
    } else if (timeRange === 'TODAY') {
      start = dataAvailability.lastUpdateTime.substring(0, 10);
    } else {
      throw new Error('Invalid time range');
    }

    const end = dataAvailability.lastUpdateTime.substring(0, 10);

    const res = await this.request(`https://monitoring.solaredge.com/services/dashboard/energy/sites/${siteId}?start-date=${start}&end-date=${end}&chart-time-unit=none&measurement-types=production,consumption,import,export,yield`, {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
      },
    });

    if (res.status === 401) {
      this.cookies = [];
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: res.statusText,
        messages: ['Unknown Error'],
      }));
      throw new Error(error?.code ?? 'Error Getting Site Energy Summary');
    }

    const { summary } = await res.json();
    return summary;
  }

  async getSiteDevices({
    siteId,
  }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await this.request(`https://monitoring.solaredge.com/services/m/api/homeautomation/v1.0/sites/${siteId}/devices`, {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
      },
    });

    if (res.status === 401) {
      this.cookies = [];
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: res.statusText,
        messages: ['Unknown Error'],
      }));
      throw new Error(error?.code ?? 'Error Getting Site Devices');
    }

    const devices = await res.json();
    return devices;
  }

  async getSiteDeviceApplianceSessionsHistory({
    siteId,
    reporterId,
    startTime = 0,
    endTime = 9999999999999,
  }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await this.request(`https://monitoring.solaredge.com/services/m/api/homeautomation/v1.0/${siteId}/devices/${reporterId}/applianceSessionsHistory?timeRange=YEAR&endTime=${endTime}&startTime=${startTime}`, {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
      },
    });

    if (res.status === 401) {
      this.cookies = [];
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: res.statusText,
        messages: ['Unknown Error'],
      }));
      throw new Error(error?.code ?? 'Error Getting Site Device Appliance Sessions History');
    }

    const applianceSessionsHistory = await res.json();
    return applianceSessionsHistory;
  }

  async setSiteDeviceApplianceActivationState({
    siteId,
    reporterId,
    state = {},
  }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await this.request(`https://monitoring.solaredge.com/services/m/api/homeautomation/v1.0/${siteId}/devices/${reporterId}/activationState`, {
      method: 'PUT',
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(state),
    });

    if (res.status === 401) {
      this.cookies = [];
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({
        code: res.statusText,
        messages: ['Unknown Error'],
      }));
      throw new Error(error?.code ?? 'Error Setting Site Device Appliance Activation State');
    }

    const applianceSessionsHistory = await res.json();
    return applianceSessionsHistory;
  }

  // The monitoring web app's dashboard endpoints, which replaced the V1 public
  // API (?api_key=, retired 2026-11-03) for the data below. Dates are
  // 'YYYY-MM-DD' in the site's local time; ranges are inclusive. See
  // docs/solaredge-v2-migration.md for what each endpoint returns.
  async getDashboard(path, query = {}, errorMessage = 'Error Getting Dashboard Data') {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const url = new URL(`https://monitoring.solaredge.com/services/dashboard${path}`);
    for (const [key, value] of Object.entries(query)) {
      // measurement-types is repeated, not comma-separated.
      for (const item of [value].flat()) {
        url.searchParams.append(key, item);
      }
    }

    const res = await this.request(url.toString(), {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
        Accept: 'application/json',
      },
    });

    if (res.status === 401) {
      throw new Error('Unauthorized');
    }

    // Errors come as { error: { code, description } } or Spring's default
    // { status, error: 'Bad Request', path }.
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      const detail = typeof error === 'string' ? error : error?.description ?? error?.code;
      throw new Error(`${errorMessage}: ${detail ?? res.statusText ?? res.status}`);
    }

    return res.json();
  }

  // { peakPower (kWp), latitude, longitude, installationDate, ... }
  async getSiteDetails({ siteId }) {
    return this.getDashboard(`/site-details/${siteId}/details`, {}, 'Error Getting Site Details');
  }

  // { inverters: { details: [{ modelName, serialNumbers }] },
  //   storage: { details: [{ manufacturer, serialNumber, capacity (kWh) }] }, ... }
  async getSiteEquipment({ siteId }) {
    return this.getDashboard(`/v2/site-details/${siteId}/equipment`, {}, 'Error Getting Site Equipment');
  }

  // { summary, chart: { measurements: [{ measurementTime, production, ... }] } }
  // in Wh. production is PV, with battery charging and discharging backed out.
  // timeUnit 'days' allows about three months (93 days worked, 120 didn't);
  // 'quarter-hours' a single day.
  async getSiteEnergy({
    siteId,
    startDate,
    endDate,
    timeUnit = 'days',
    measurementTypes = ['production'],
  }) {
    return this.getDashboard(`/energy/sites/${siteId}`, {
      'start-date': startDate,
      'end-date': endDate,
      'chart-time-unit': timeUnit,
      'measurement-types': measurementTypes,
    }, 'Error Getting Site Energy');
  }

  // { measurements: [{ measurementTime, production }] }: 15-minute mean PV
  // power in W, battery discharge excluded. 8 days per request worked, 14
  // didn't.
  async getSitePower({
    siteId,
    startDate,
    endDate,
    measurementTypes = ['production'],
  }) {
    return this.getDashboard(`/power/sites/${siteId}`, {
      'start-date': startDate,
      'end-date': endDate,
      'chart-time-unit': 'quarter-hours',
      'measurement-types': measurementTypes,
    }, 'Error Getting Site Power');
  }

  // { measurements: [{ measurementTime, stateOfCharge }] }: 5-minute samples
  // for a single day. Samples later than now are null.
  async getBatteryStateOfCharge({ siteId, date }) {
    return this.getDashboard(`/battery/sites/${siteId}`, {
      'start-date': date,
      'end-date': date,
    }, 'Error Getting Battery State of Charge');
  }

  // { sources: { total, pv, grid }, destinations: { total, building, grid } }:
  // energy into and out of the battery over the range, in Wh.
  async getStorageEnergyDistribution({ siteId, startDate, endDate }) {
    return this.getDashboard(`/storage/energy/distribution/sites/${siteId}`, {
      'start-date': startDate,
      'end-date': endDate,
    }, 'Error Getting Storage Energy Distribution');
  }

  // The site's IANA time zone. Only the scripts need this; the app uses
  // Homey's.
  async getSiteTimeZone({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await this.request(`https://monitoring.solaredge.com/services/cni/ui-api/sites/${siteId}`, {
      headers: {
        ...this.headers,
        Cookie: this.cookies.join('; '),
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(res.statusText ?? 'Error Getting Site Time Zone');
    }

    const { timezone } = await res.json();
    return timezone;
  }

}
