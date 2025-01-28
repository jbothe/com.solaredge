import Homey from 'homey';
import SolarEdgeAPI from './SolarEdgeAPI.mjs';

const POLL_INTERVAL = 1000 * 5; // 5 seconds

export default class SolarEdgeDevice extends Homey.Device {

  async onInit() {
    this.api = new SolarEdgeAPI();

    this.pollInterval = setInterval(() => this.poll(), POLL_INTERVAL);
    this.poll();
  }

  poll() {
    this.onPoll()
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch(err => {
        this.error(`Error Polling: ${err.message}`);
        this.setUnavailable(err).catch(this.error);
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

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      await this.api.login({
        username: newSettings.username,
        password: newSettings.password,
      });

      this.poll();
    }
  }

};
