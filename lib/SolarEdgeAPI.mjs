import fetch from 'node-fetch';

export default class SolarEdgeAPI {
  cookies = [];
  headers = {
    'User-Agent': 'SolarEdge/14 CFNetwork/1568.200.51 Darwin/24.1.0',
    'CLIENT-VERSION': '3.12',
  };

  timeZone = '';

  constructor(
    timeZone
  ) {
    if (timeZone) {
      this.timeZone = timeZone;
    }
  }

  isLoggedIn() {
    return this.cookies.length > 0;
  }

  getCurrentDate() {
    // Return date in Homey timezone
    return new Date(
      new Date().toLocaleString("en-US", { timeZone: this.timeZone })
    );
  }

  getIsoStringFromPast(minutesOffset) {
    const date = new Date(
      this.getCurrentDate().getTime() - minutesOffset * 60000
    );
    return this.getIsoString(date);
  }

  getIsoString(date)  {
    const offsetMs = date.getTimezoneOffset() * 60 * 1000;
    const msLocal = date.getTime() - offsetMs;
    const dateLocal = new Date(msLocal);
    const iso = dateLocal.toISOString();
    return iso.slice(0, 19).replace("T", " ");
  }

  async login({
    username,
    password,
  }) {
    const res = await fetch('https://monitoring.solaredge.com/solaredge-apigw/api/login', {
      method: 'POST',
      body: new URLSearchParams({
        j_username: username,
        j_password: password,
      }),
      redirect: 'manual',
    });

    if (res.status !== 302) {
      throw new Error('Invalid e-mail and/or password.');
    }

    this.cookies = res.headers.raw()['set-cookie'].map(cookie => cookie.split(';')[0]);
  }

  async getSites() {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await fetch('https://monitoring.solaredge.com/services/m/so/sites/', {
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
    console.log('Sites', sites);
    return sites;
  }

  async getOldSites({ apikey }) {
    const res = await fetch('https://monitoringapi.solaredge.com/sites/list??&format=json&api_key=' + apikey);

    if (res.status === 401) {
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      throw new Error(res.statusText ?? 'Error Getting Old Sites');
    }

    const { sites } = await res.json();
    console.log('Old Sites', sites);
    return sites;
  }

  async getSite({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await fetch(`https://monitoring.solaredge.com/solaredge-apigw/api/v3/sites/${siteId}`, {
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
        messages: ['Unknown Error']
      }));
      throw new Error(error?.code ?? 'Error Getting Site');
    }

    const site = await res.json();
    console.log('Site', siteId, site);
    return site;
  }

  async getCapabilities({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await fetch(` https://monitoring.solaredge.com/services/m/so/dashboard/site/${siteId}/details`, {
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
        messages: ['Unknown Error']
      }));
      throw new Error(error?.code ?? 'Error Getting Site Capabilities');
    }

    const capabilities = await res.json();
    console.log('Capabilities', siteId, capabilities);
    return capabilities;
  }

  async getSitePowerflow({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await fetch(`https://monitoring.solaredge.com/services/m/so/dashboard/v2/site/${siteId}/powerflow/latest?components=consumption%2Cgrid%2Cstorage%2Cev-charger`, {
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
        messages: ['Unknown Error']
      }));
      throw new Error(error?.code ?? 'Error Getting Site Powerflow');
    }

    const powerflow = await res.json();
    //console.log('Powerflow', powerflow);
    return powerflow;
  }

  async getSiteEnergyOverview({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await fetch(`https://monitoring.solaredge.com/services/m/so/dashboard/site/${siteId}/energyOverview`, {
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
        messages: ['Unknown Error']
      }));
      throw new Error(error?.code ?? 'Error Getting Site Energy Overview');
    }

    const energyOverview = await res.json();
    console.log('Energy', energyOverview);
    return energyOverview;
  }

  async getSiteDataAvailability({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await fetch(`https://monitoring.solaredge.com/services/dashboard/data-availability/sites/${siteId}`, {
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
        messages: ['Unknown Error']
      }));
      throw new Error(error?.code ?? 'Error Getting Site Data Availability');
    }

    const dataAvailability = await res.json();
    console.log('Data Availability', dataAvailability);
    return dataAvailability;
  }

  async getSiteEnergySummary({ siteId }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const dataAvailability = await this.getSiteDataAvailability({ siteId });

    if (!dataAvailability.consumptionDataAvailableFrom?.length || !dataAvailability.lastUpdateTime?.length) {
      throw new Error('No data availability');
    }

    const start = dataAvailability.consumptionDataAvailableFrom.substring(0, 10);
    const end = dataAvailability.lastUpdateTime.substring(0, 10);

    const res = await fetch(`https://monitoring.solaredge.com/services/dashboard/energy/sites/${siteId}?start-date=${start}&end-date=${end}&chart-time-unit=none&measurement-types=production,consumption,import,export,yield`, {
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
        messages: ['Unknown Error']
      }));
      throw new Error(error?.code ?? 'Error Getting Site Energy Summary');
    }

    const { summary } = await res.json();
    console.log('Energy Summary', summary);
    return summary;
  }

  async getSiteMeasurements({
    siteId,
    period = 'YEAR',
    measurementUnit = 'WATT_HOUR',
    endDate = '2025-12-31',
  }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const url = new URL(`https://monitoring.solaredge.com/services/m/so/dashboard/site/${siteId}/measurements`);
    url.searchParams.append('period', period);
    url.searchParams.append('measurement-unit', measurementUnit);
    url.searchParams.append('end-date', endDate);

    const res = await fetch(url, {
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
        messages: ['Unknown Error']
      }));
      throw new Error(error?.code ?? 'Error Getting Site Measurements');
    }

    const measurements = await res.json();
    return measurements;
  }

  async getSiteDevices({
    siteId,
  }) {
    if (!this.isLoggedIn()) {
      throw new Error('Not Logged In');
    }

    const res = await fetch(`https://monitoring.solaredge.com/services/m/api/homeautomation/v1.0/sites/${siteId}/devices`, {
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
        messages: ['Unknown Error']
      }));
      throw new Error(error?.code ?? 'Error Getting Site Devices');
    }

    const devices = await res.json();
    console.log('Devices', devices);

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


    const res = await fetch(`https://monitoring.solaredge.com/services/m/api/homeautomation/v1.0/${siteId}/devices/${reporterId}/applianceSessionsHistory?timeRange=YEAR&endTime=${endTime}&startTime=${startTime}`, {
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
        messages: ['Unknown Error']
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

    const res = await fetch(`https://monitoring.solaredge.com/services/m/api/homeautomation/v1.0/${siteId}/devices/${reporterId}/activationState`, {
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
        messages: ['Unknown Error']
      }));
      throw new Error(error?.code ?? 'Error Setting Site Device Appliance Activation State');
    }

    const applianceSessionsHistory = await res.json();
    return applianceSessionsHistory;

  }

  async getSiteStorage({
      apikey,
      siteId
  }) {
    const url = 'https://monitoringapi.solaredge.com/site/' + siteId + '/storageData?format=json&api_key=' + apikey + '&startTime=' + this.getIsoStringFromPast(10) + '&endTime=' + this.getIsoStringFromPast(0)
    console.log(url)
    const res = await fetch(url);

    if (res.status === 401) {
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      throw new Error(res.statusText ?? 'Error Getting Site Storage');
    }

    const { storageData } = await res.json();
    console.log('Storage', storageData);
    return storageData;
  }

}
