import Homey from 'homey';
import SolarEdgeAPI from './SolarEdgeAPI.mjs';

const POLL_INTERVAL = 1000 * 10; // 10 seconds

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

    // Get Site Info
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

        // Retry
        site = await this.api.getSite({
          siteId: this.getData().siteId,
        });
      } else {
        throw err;
      }
    }

    const power = site?.fieldOverview?.fieldOverview?.currentPower?.currentPower;
    if (typeof power === 'number') {
      await this.setCapabilityValue('measure_power', Math.round(power)).catch(this.error);
    }

    const energyTotal = site?.fieldOverview?.fieldOverview?.lifeTimeData?.energy;
    if (typeof energyTotal === 'number') {
      await this.setCapabilityValue('meter_power', energyTotal / 1000).catch(this.error);;
    }

    const energyToday = site?.fieldOverview?.fieldOverview?.lastDayData?.energy;
    if (typeof energyToday === 'number') {
      await this.setCapabilityValue('meter_power.day', energyToday / 1000).catch(this.error);;
    }

    const energyMonth = site?.fieldOverview?.fieldOverview?.lastMonthData?.energy;
    if (typeof energyMonth === 'number') {
      await this.setCapabilityValue('meter_power.month', energyMonth / 1000).catch(this.error);;
    }

    const energyYear = site?.fieldOverview?.fieldOverview?.lastYearData?.energy;
    if (typeof energyYear === 'number') {
      await this.setCapabilityValue('meter_power.year', energyYear / 1000).catch(this.error);;
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      await this.api.login({
        username: newSettings.username,
        password: newSettings.password,
      });

      this.poll();
    }
  }

};
