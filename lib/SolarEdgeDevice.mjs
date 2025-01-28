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

    // Get Powerflow
    const sitePowerflow = await this.api.getSitePowerflow({
      siteId: this.getData().siteId,
    });

    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      await this.setCapabilityValue('measure_power', Math.round(sitePowerflow.solarProduction.currentPower * 1000)).catch(this.error);
    }

    // Get Energy Overview
    const { energyProducedOverviewList } = await this.api.getSiteEnergyOverview({
      siteId: this.getData().siteId,
    });

    for (const energyProducedOverviewListItem of Object.values(energyProducedOverviewList)) {
      switch (energyProducedOverviewListItem.timePeriod) {
        case 'LIFE_TIME': {
          await this.setCapabilityValue('meter_power', energyProducedOverviewListItem.energy / 1000).catch(this.error);
          break;
        }
        case 'LAST_YEAR': {
          await this.setCapabilityValue('meter_power.year', energyProducedOverviewListItem.energy / 1000).catch(this.error);
          break;
        }
        case 'LAST_MONTH': {
          await this.setCapabilityValue('meter_power.month', energyProducedOverviewListItem.energy / 1000).catch(this.error);
          break;
        }
        case 'LAST_DAY': {
          await this.setCapabilityValue('meter_power.day', energyProducedOverviewListItem.energy / 1000).catch(this.error);
          break;
        }
      }
    }
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
