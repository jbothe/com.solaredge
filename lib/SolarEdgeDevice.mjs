import Homey from 'homey';
import SolarEdgeAPI from './SolarEdgeAPI.mjs';

export default class SolarEdgeDevice extends Homey.Device {

  api = new SolarEdgeAPI();

  async onInit() {
    this.pollInterval = setInterval(() => this.poll(), 1000 * 60 * 1);
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

    let site;
    try {
      site = await this.api.getSite({
        siteId: this.getData().siteId,
      });
    } catch (err) {
      // If Unauthorized, re-login
      if (err.message === 'Unauthorized') { // TODO: Check if this is the correct error message
        await this.api.login({
          username: this.getSettings().username,
          password: this.getSettings().password,
        });

        site = await this.api.getSite({
          siteId: this.getData().siteId,
        });
      }

      throw err;
    }

    const energy = site?.fieldOverview?.fieldOverview?.lifeTimeData?.energy;
    if (typeof energy === 'number') {
      this.setCapabilityValue('meter_power', Math.round(energy));
    }

    const power = site?.fieldOverview?.fieldOverview?.currentPower?.currentPower;
    if (typeof power === 'number') {
      this.setCapabilityValue('measure_power', Math.round(power));
    }
  }

  async onSettings(oldSettings, newSettings, changedKeys) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      await this.api.login({
        username: newSettings.username,
        password: newSettings.password,
      });
    }
  }

};
