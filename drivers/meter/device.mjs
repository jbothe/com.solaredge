import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceMeter extends SolarEdgeDevice {

  async onPoll() {
    await super.onPoll();

    const { siteId } = this.getData();

    // Get Powerflow
    const sitePowerflow = await this.api.getSitePowerflow({ siteId });

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

    // Set Device Availability
    if (sitePowerflow.grid?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

  async onLongPoll() {
    await super.onPoll();

    const { siteId } = this.getData();
    const summary = await this.api.getSiteEnergySummary({ siteId });

    if (summary.import && summary.export) {
      let imported = summary.import;
      if (typeof imported === 'number') {
        imported = Math.round(summary.import / 1000)
        await this.setCapabilityValue('meter_power.imported', imported).catch(this.error);
      }

      let exported = summary.export;
      if (typeof exported === 'number') {
        exported = Math.round(summary.export / 1000)
        await this.setCapabilityValue('meter_power.exported', exported).catch(this.error);
      }
    }
  }
};
