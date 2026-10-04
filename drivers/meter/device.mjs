import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceMeter extends SolarEdgeDevice {

  static RETIRED_CAPABILITIES = [
    // Renamed to meter_power.imported_total / exported_total in a21da26.
    'meter_power.imported',
    'meter_power.exported',
    // Upstream added it (aaf2f03) when measure_power was house consumption.
    // Since this fork made measure_power the grid reading (bff1db2), merging
    // the two (fca4919) left it a duplicate. measure_power.consumption takes
    // its place.
    'measure_power.grid',
  ];

  async onInit() {
    // Adds measure_power.consumption and puts everything in the manifest's
    // order (power, consumption, solar, outage, today, totals).
    await this.orderCapabilities(this.driver.manifest.capabilities);

    await super.onInit();
  }

  async onSitePowerflow(sitePowerflow) {
    if (typeof sitePowerflow.grid?.currentPower === 'number') {
      let power = Math.round(sitePowerflow.grid.currentPower * 1000);

      // Invert the value when exporting
      if (sitePowerflow.grid?.status === 'export') {
        power *= -1;
      }

      await this.setCapabilityValue('measure_power', power).catch(this.error);
    }

    // Set power outage alarm
    if (sitePowerflow.grid?.hasPowerOutage !== undefined) {
      if (sitePowerflow.grid?.hasPowerOutage) {
        await this.setCapabilityValue('alarm_generic', true).catch(this.error);
      } else {
        await this.setCapabilityValue('alarm_generic', false).catch(this.error);
      }
    }

    // House consumption. SolarEdge reports null rather than 0 when the house
    // draws nothing measurable.
    if (sitePowerflow.consumption?.currentPower === null) {
      await this.setCapabilityValue('measure_power.consumption', 0).catch(this.error);
    } else if (typeof sitePowerflow.consumption?.currentPower === 'number') {
      await this.setCapabilityValue('measure_power.consumption', Math.round(sitePowerflow.consumption.currentPower * 1000)).catch(this.error);
    }

    // Solar
    if (typeof sitePowerflow.solarProduction?.currentPower === 'number') {
      await this.setCapabilityValue('measure_power.solar', Math.round(sitePowerflow.solarProduction.currentPower * 1000)).catch(this.error);
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
        imported = Math.round(summary.import / 1000);
        await this.setCapabilityValue('meter_power.imported_total', imported).catch(this.error);
      }

      let exported = summary.export;
      if (typeof exported === 'number') {
        exported = Math.round(summary.export / 1000);
        await this.setCapabilityValue('meter_power.exported_total', exported).catch(this.error);
      }
    }

    const summaryToday = await this.api.getSiteEnergySummary(siteId, 'TODAY');

    if (summaryToday.import && summaryToday.export) {
      let importedToday = summaryToday.import;
      if (typeof importedToday === 'number') {
        importedToday = Math.round(summaryToday.import / 1000);
        await this.setCapabilityValue('meter_power.imported_today', importedToday).catch(this.error);
      }

      let exportedToday = summaryToday.export;
      if (typeof exportedToday === 'number') {
        exportedToday = Math.round(summaryToday.export / 1000);
        await this.setCapabilityValue('meter_power.exported_today', exportedToday).catch(this.error);
      }
    }
  }

}
