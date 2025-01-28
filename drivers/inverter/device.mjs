import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceInverter extends SolarEdgeDevice {

  async onPoll() {
    await super.onPoll();

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

};