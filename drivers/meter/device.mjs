import energyShares from '../../lib/EnergyShares.mjs';
import { localDate } from '../../lib/LocalDate.mjs';
import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

// Wh to kWh, rounded to the given number of decimals.
const kwh = (wh, decimals) => {
  const scale = 10 ** decimals;
  return Math.round((wh / 1000) * scale) / scale;
};

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
    // The same reading as the solar device's power, from the same request.
    'measure_power.solar',
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

    // Homey Energy works out each hour's import and export from how much
    // these totals move, so they keep Wh precision rather than whole kWh.
    if (summary.import && summary.export) {
      if (typeof summary.import === 'number') {
        await this.setCapabilityValue('meter_power.imported_total', kwh(summary.import, 3)).catch(this.error);
      }

      if (typeof summary.export === 'number') {
        await this.setCapabilityValue('meter_power.exported_total', kwh(summary.export, 3)).catch(this.error);
      }
    }

    // Today, in the site's local time: production and consumption with where
    // each went or came from, and what charged the battery, for the
    // self-consumption and self-sufficiency shares.
    const today = localDate(new Date(), this.homey.clock.getTimezone());
    const { summary: summaryToday } = await this.api.getSiteEnergy({
      siteId,
      startDate: today,
      endDate: today,
      measurementTypes: ['production', 'consumption', 'production-distribution-with-storage', 'consumption-distribution-with-storage', 'import', 'export'],
    });
    // A site without a battery may have no storage figures at all.
    const battery = await this.api.getStorageEnergyDistribution({ siteId, startDate: today, endDate: today }).catch(() => null);

    if (typeof summaryToday?.import === 'number') {
      await this.setCapabilityValue('meter_power.imported_today', kwh(summaryToday.import, 2)).catch(this.error);
    }
    if (typeof summaryToday?.export === 'number') {
      await this.setCapabilityValue('meter_power.exported_today', kwh(summaryToday.export, 2)).catch(this.error);
    }

    const { selfConsumption, selfSufficiency } = energyShares(summaryToday, battery?.sources);
    const percent = (share) => (share === null ? null : Math.round(share * 100));
    await this.setCapabilityValue('solar_self_consumption', percent(selfConsumption)).catch(this.error);
    await this.setCapabilityValue('solar_self_sufficiency', percent(selfSufficiency)).catch(this.error);
  }

}
