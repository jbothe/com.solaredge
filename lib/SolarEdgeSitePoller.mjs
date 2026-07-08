import SolarEdgeAPI from './SolarEdgeAPI.mjs';

export default class SolarEdgeSitePoller {

  static POLL_INTERVAL = 1000 * 10; // 10 seconds

  constructor(homey, siteId) {
    this.homey = homey;
    this.siteId = siteId;
    this.api = null;
    this.credentialsSource = null;
    this.devices = new Set();
    this.pollInterval = null;
  }

  registerDevice(device) {
    this.devices.add(device);

    if (!this.api) {
      this.api = new SolarEdgeAPI(this.homey.clock.getTimezone());
      this.credentialsSource = device;
    }

    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => this.poll(), SolarEdgeSitePoller.POLL_INTERVAL);
      this.poll();
    }
  }

  unregisterDevice(device) {
    this.devices.delete(device);

    if (device === this.credentialsSource) {
      this.credentialsSource = this.devices.values().next().value ?? null;
    }

    if (this.devices.size === 0) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.api = null;
      this.credentialsSource = null;
    }
  }

  invalidateSession(device) {
    if (device === this.credentialsSource && this.api) {
      this.api.cookies = [];
    }
  }

  async poll() {
    try {
      if (!this.api.isLoggedIn()) {
        const { username, password } = this.credentialsSource.getSettings();
        await this.api.login({ username, password });
      }

      const sitePowerflow = await this.api.getSitePowerflow({ siteId: this.siteId });

      for (const device of this.devices) {
        device.onSitePowerflow(sitePowerflow).catch(device.error.bind(device));
      }
    } catch (err) {
      for (const device of this.devices) {
        device.onSitePowerflowError(err).catch(device.error.bind(device));
      }
    }
  }

};
