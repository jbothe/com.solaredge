import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceInverter extends SolarEdgeDevice {

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

    // Get Inverter Serial
    let inverterSerial = await this.getStoreValue('inverterSerial');
    if (!inverterSerial) {
      const reporters = await this.api.getEquipmentList({
        apikey: this.getSettings().apikey,
        siteId: this.getData().siteId,
      });

      inverterSerial = reporters?.list?.[0]?.serialNumber;
      if (inverterSerial) {
        await this.setStoreValue('inverterSerial', inverterSerial);
      }
    }

    if (inverterSerial) {
      // Get Inverter Data
      const inverterData = await this.api.getSiteInverter({
        apikey: this.getSettings().apikey,
        siteId: this.getData().siteId,
        inverterSerial,
      });

      if (inverterData.telemetries?.length > 0) {
        const latestTelemetry = inverterData.telemetries[inverterData.telemetries.length - 1];

        const voltage = latestTelemetry.L1Data?.acVoltage;
        if (typeof voltage === 'number') {
          if (!this.hasCapability('measure_voltage')) {
            await this.addCapability('measure_voltage');
          }
          await this.setCapabilityValue('measure_voltage', voltage).catch(this.error);
        }

        const temp = latestTelemetry.temperature;
        if (typeof temp === 'number') {
          if (!this.hasCapability('measure_temperature')) {
            await this.addCapability('measure_temperature');
          }
          await this.setCapabilityValue('measure_temperature', temp).catch(this.error);
        }

        const { dcVoltage } = latestTelemetry;
        if (typeof dcVoltage === 'number') {
          if (!this.hasCapability('measure_voltage.dc')) {
            await this.addCapability('measure_voltage.dc');
          }
          await this.setCapabilityValue('measure_voltage.dc', dcVoltage).catch(this.error);
        }
      }
    }
  }

}
