import SolarEdgeAPI from './SolarEdgeAPI.mjs';

// One per site, shared by its devices: polls the live power flow every 10
// seconds for all of them, and holds the site's one SolarEdge session, which
// the devices use for everything else too.
export default class SolarEdgeSitePoller {

  static POLL_INTERVAL = 1000 * 10; // 10 seconds

  constructor(homey, siteId) {
    this.homey = homey;
    this.siteId = siteId;
    this.api = null;
    this.credentials = null;
    this.devices = new Set();
    this.pollInterval = null;
    this.polling = false;
  }

  registerDevice(device) {
    this.devices.add(device);

    if (!this.api) {
      this.api = new SolarEdgeAPI();
      const { username, password } = device.getSettings();
      this.credentials = { username, password };
    }

    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => this.tick(), SolarEdgeSitePoller.POLL_INTERVAL);
      this.tick();
    }
  }

  unregisterDevice(device) {
    this.devices.delete(device);

    if (this.devices.size === 0) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.api = null;
      this.credentials = null;
    }
  }

  async ensureSignedIn() {
    await this.api.ensureLoggedIn(this.credentials);
  }

  // New credentials for the site's session, already checked by logging in
  // with them: cookies is that login's session, so it needn't be repeated.
  setCredentials({ username, password }, cookies) {
    this.credentials = { username, password };
    this.api.cookies = cookies;
  }

  async poll() {
    // Ticks fire on a fixed interval regardless of how long a poll takes, so
    // without this guard a slow request lets them stack up unboundedly.
    if (this.polling) {
      console.log(`[SolarEdgeSitePoller] Skipping tick for site ${this.siteId}: previous poll still in flight`);
      return;
    }

    this.polling = true;

    try {
      await this.ensureSignedIn();

      const sitePowerflow = await this.api.getSitePowerflow({ siteId: this.siteId });

      for (const device of this.devices) {
        device.handleSitePowerflow(sitePowerflow).catch(device.error.bind(device));
      }
    } catch (err) {
      for (const device of this.devices) {
        device.onSitePowerflowError(err).catch(device.error.bind(device));
      }
    } finally {
      this.polling = false;
    }
  }

  tick() {
    this.poll().catch((err) => {
      console.error(`[SolarEdgeSitePoller] Unexpected error polling site ${this.siteId}:`, err);
    });
  }

}
