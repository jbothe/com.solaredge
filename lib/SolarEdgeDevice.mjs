import Homey from 'homey';
import SolarEdgeAPI from './SolarEdgeAPI.mjs';

export default class SolarEdgeDevice extends Homey.Device {

  static LONG_POLL_INTERVAL = 1000 * 60 * 15; // 15 mins

  async onInit() {
    this.api = new SolarEdgeAPI(this.homey.clock.getTimezone());

    this.sitePoller = this.homey.app.getSitePoller(this.getData().siteId);
    this.sitePoller.registerDevice(this);

    this.longPollInterval = setInterval(() => this.longPoll(), this.constructor.LONG_POLL_INTERVAL);

    this.longPoll();
  }

  async onUninit() {
    this.sitePoller?.unregisterDevice(this);

    if (this.longPollInterval) {
      clearInterval(this.longPollInterval);
    }
  }

  longPoll() {
    this.onLongPoll().catch((err) => {
      this.error(`Error Long Polling: ${err.message}`);
    });
  }

  async onSitePowerflow(sitePowerflow) {
    // Overload Me
  }

  async onSitePowerflowError(err) {
    this.error(`Error Polling: ${err.message}`);
    await this.setUnavailable(err).catch(this.error);
  }

  async ensureSignedIn() {
    if (!this.api.isLoggedIn()) {
      await this.api.login({
        username: this.getSettings().username,
        password: this.getSettings().password,
      });
    }
  }

  async onLongPoll() {
    await this.ensureSignedIn();

    // Overload Me
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      await this.api.login({
        username: newSettings.username,
        password: newSettings.password,
      });

      this.sitePoller?.invalidateSession(this);

      this.longPoll();
    }

    if (changedKeys.includes('apikey')) {
      await this.api.getOldSites({ apikey: newSettings.apikey });
      this.longPoll();
    }
  }

}
