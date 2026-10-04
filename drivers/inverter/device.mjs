import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceInverter extends SolarEdgeDevice {

  // Read from the V1 API's inverter telemetry, which SolarEdge retired on
  // 2026-11-03. Nothing a homeowner login can reach reports them any more.
  static RETIRED_CAPABILITIES = ['measure_temperature', 'measure_voltage', 'measure_voltage.dc'];

  async onInit() {
    // Puts everything in the manifest's order (power, today, month, year,
    // total) for devices that gained capabilities at runtime.
    await this.orderCapabilities(this.driver.manifest.capabilities);

    await super.onInit();
  }

  async onSitePowerflow(sitePowerflow) {
    // Solar
    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      await this.setCapabilityValue('measure_power', Math.round(sitePowerflow.solarProduction.currentPower * 1000)).catch(this.error);
    }

    if (sitePowerflow.solarProduction?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

  async onLongPoll() {
    await super.onLongPoll();

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
        default: {
          break;
        }
      }
    }
  }

}
