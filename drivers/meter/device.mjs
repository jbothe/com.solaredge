import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceMeter extends SolarEdgeDevice {

  async onSitePowerflow(sitePowerflow) {
    if (typeof sitePowerflow.grid?.currentPower === 'number') {
      let power = Math.round(sitePowerflow.grid.currentPower * 1000);

      // Invert the value when exporting
      if (sitePowerflow.grid?.status === 'export') {
        power = power * -1;
      }

      await this.setCapabilityValue('measure_power', power).catch(this.error);
    }

    // Set power outage alarm
    if (sitePowerflow.grid?.hasPowerOutage !== undefined) {
      if (sitePowerflow.grid?.hasPowerOutage) {
        await this.setCapabilityValue('alarm_generic', true).catch(this.error);
      }
      else {
        await this.setCapabilityValue('alarm_generic', false).catch(this.error);
      }
    }

    // Grid
    if (typeof sitePowerflow.grid?.currentPower === 'number') {
      if (!this.hasCapability('measure_power.grid')) {
        await this.addCapability('measure_power.grid');
      }

      let power = Math.round(sitePowerflow.grid.currentPower * 1000);
      if (sitePowerflow.grid?.status === 'export') {
        power *= -1;
      }

      await this.setCapabilityValue('measure_power.grid', power).catch(this.error);
    }

    // Solar
    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      if (!this.hasCapability('measure_power.solar')) {
        await this.addCapability('measure_power.solar');
      }

      let power = Math.round(sitePowerflow.solarProduction.currentPower * 1000);
      if (sitePowerflow.solarProduction?.isProducing === false) {
        power *= -1;
      }

      await this.setCapabilityValue('measure_power.solar', power).catch(this.error);
    }

    // Set Device Availability
    if (sitePowerflow.grid?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

  async onLongPoll() {
    await super.onLongPoll();

    const { siteId } = this.getData();
    const summary = await this.api.getSiteEnergySummary(siteId, 'LIFETIME');

    if (summary.import && summary.export) {
      let imported = summary.import;
      if (typeof imported === 'number') {
        imported = Math.round(summary.import / 1000)
        await this.setCapabilityValue('meter_power.imported_total', imported).catch(this.error);
      }

      let exported = summary.export;
      if (typeof exported === 'number') {
        exported = Math.round(summary.export / 1000)
        await this.setCapabilityValue('meter_power.exported_total', exported).catch(this.error);
      }
    }

    const summaryToday = await this.api.getSiteEnergySummary(siteId, 'TODAY');

    if (summaryToday.import && summaryToday.export) {
      let importedToday = summaryToday.import;
      if (typeof importedToday === 'number') {
        importedToday = Math.round(summaryToday.import / 1000)
        await this.setCapabilityValue('meter_power.imported_today', importedToday).catch(this.error);
      }

      let exportedToday = summaryToday.export;
      if (typeof exportedToday === 'number') {
        exportedToday = Math.round(summaryToday.export / 1000)
        await this.setCapabilityValue('meter_power.exported_today', exportedToday).catch(this.error);
      }
    }
  }
};
