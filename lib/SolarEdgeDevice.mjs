import Homey from 'homey';
import SolarEdgeAPI from './SolarEdgeAPI.mjs';

export default class SolarEdgeDevice extends Homey.Device {

  static POLL_INTERVAL = 1000 * 5; // 5 seconds
  static LONG_POLL_INTERVAL = 1000 * 60 * 15; // 15 mins


  async onInit() {
    this.api = new SolarEdgeAPI(this.homey.clock.getTimezone());

    this.pollInterval = setInterval(() => this.poll(), this.constructor.POLL_INTERVAL);
    this.longPollInterval = setInterval(() => this.longPoll(), this.constructor.LONG_POLL_INTERVAL);

    this.poll();
    this.longPoll();
  }

  async onUninit() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }

    if (this.longPollInterval) {
      clearInterval(this.longPollInterval);
    }
  }

  poll() {
    this.onPoll().catch(err => {
      this.error(`Error Polling: ${err.message}`);
      this.setUnavailable(err).catch(this.error);
    });
  }

  longPoll() {
    this.onLongPoll().catch(err => {
      this.error(`Error Long Polling: ${err.message}`);
    });
  }

  async onPoll() {
    // Ensure Signed In
    if (!this.api.isLoggedIn()) {
      await this.api.login({
        username: this.getSettings().username,
        password: this.getSettings().password,
      });
    }

    // Overload Me
  }

  async onLongPoll() {
    // Overload Me
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      await this.api.login({
        username: newSettings.username,
        password: newSettings.password,
      });

      this.poll();
    }

    if (changedKeys.includes('apikey')) {
      await this.api.getOldSites({ apikey: newSettings.apikey });
      this.longPoll();
    }
  }

};
