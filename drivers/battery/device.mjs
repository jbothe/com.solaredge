import {
  buildSlots,
  dischargeEfficiency,
  dischargeSegments,
  estimateFullPackWh,
  stateOfHealth,
} from '../../lib/BatteryHealth.mjs';
import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';
import { addDays, localDate, localDateTime } from '../../lib/LocalDate.mjs';

export default class SolarEdgeDeviceBattery extends SolarEdgeDevice {

  static RETIRED_CAPABILITIES = [
    // Read from the V1 API's storage telemetry, which SolarEdge retired on
    // 2026-11-03. Nothing a homeowner login can reach reports it any more.
    'measure_temperature',
    // Renamed to meter_power.charged_total / discharged_total in a21da26.
    'meter_power.lifetime_charged',
    'meter_power.lifetime_discharged',
  ];

  // Discharge stretches older than this drop out of the health estimate, so
  // it follows the battery as it ages.
  static HEALTH_WINDOW_DAYS = 30;

  // Yesterday's data is final by then.
  static HEALTH_AFTER_HOUR = 1;

  static HEALTH_RETRY_AFTER = 1000 * 60 * 60; // 1 hour

  // The backup reserve is a setting that rarely changes.
  static RESERVE_REFRESH_AFTER = 1000 * 60 * 60; // 1 hour

  // Homey only moves a capability's lastUpdated when its value changes, and
  // the Energy tab appears to stop showing the battery's power, and its
  // flow, once that's been a while: on 2026-10-18 a grid charge held a steady 3290 W
  // from 11:00, and by 11:35 the battery tile read just "Charging" while
  // Homey's live energy report still had the 3290 W. A power held this long
  // is sent 1 W off and straight back, which refreshes it.
  static POWER_REFRESH_AFTER = 1000 * 60 * 5; // 5 mins

  async onInit() {
    // Devices paired before the today/total split got the totals added at
    // runtime and the today meters after them; this restores the manifest's
    // order (power, state, today, total, SoH).
    await this.orderCapabilities(this.driver.manifest.capabilities);

    this.lastHealthAttempt = 0;
    this.lastReserveUpdate = 0;
    this.lastPowerChange = Date.now();

    await super.onInit();
  }

  async onSitePowerflow(sitePowerflow) {
    if (typeof sitePowerflow.storage?.currentPower === 'number') {
      let power = Math.round(sitePowerflow.storage.currentPower * 1000);

      // Invert the value when discharging
      if (sitePowerflow.storage?.status === 'discharging') {
        power *= -1;
      }

      await this.setPower(power);
    }

    if (typeof sitePowerflow.storage?.chargeLevel === 'number') {
      const soc = Math.round(sitePowerflow.storage?.chargeLevel);
      await this.setCapabilityValue('measure_battery', soc).catch(this.error);
    }

    switch (sitePowerflow.storage?.status) {
      case 'charging': {
        await this.setCapabilityValue('battery_charging_state', 'charging').catch(this.error);
        break;
      }
      case 'discharging': {
        await this.setCapabilityValue('battery_charging_state', 'discharging').catch(this.error);
        break;
      }
      case 'idle': {
        await this.setCapabilityValue('battery_charging_state', 'idle').catch(this.error);
        break;
      }
      default: {
        break;
      }
    }

    if (sitePowerflow.storage?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

  async onLongPoll() {
    await super.onLongPoll();

    const { siteId } = this.getData();
    const site = await this.getSiteInfo();
    const timeZone = this.homey.clock.getTimezone();
    const today = localDate(new Date(), timeZone);

    // Energy into the battery (sources) and out of it (destinations). Homey
    // Energy works out each hour's charge and discharge from how much these
    // move, so they keep Wh precision: in whole kWh a morning's discharge
    // lands as 1 kWh steps in whichever hours the total crosses one.
    const lifetime = await this.api.getStorageEnergyDistribution({ siteId, startDate: site.installationDate, endDate: today });
    await this.setEnergyCapability('meter_power.charged_total', lifetime.sources?.total, 3);
    await this.setEnergyCapability('meter_power.discharged_total', lifetime.destinations?.total, 3);

    const daily = await this.api.getStorageEnergyDistribution({ siteId, startDate: today, endDate: today });
    await this.setEnergyCapability('meter_power.charged_today', daily.sources?.total, 2);
    await this.setEnergyCapability('meter_power.charged_solar_today', daily.sources?.pv, 2);
    await this.setEnergyCapability('meter_power.charged_grid_today', daily.sources?.grid, 2);
    await this.setEnergyCapability('meter_power.discharged_today', daily.destinations?.total, 2);

    await this.updateReserve().catch((err) => {
      this.error(`Error reading the backup reserve: ${err.message}`);
    });

    // Its own failures shouldn't mark the energy totals as stale.
    await this.updateHealth({ site, today, lifetime }).catch((err) => {
      this.error(`Error estimating battery health: ${err.message}`);
    });
  }

  async setPower(power) {
    const now = Date.now();

    if (power !== this.getCapabilityValue('measure_power')) {
      this.lastPowerChange = now;
    } else if (now - this.lastPowerChange > this.constructor.POWER_REFRESH_AFTER) {
      this.lastPowerChange = now;
      // Towards zero, so a charge or discharge doesn't flip direction for
      // that instant; 0 W (idle) has no direction to keep.
      const nudged = power === 0 ? 1 : power - Math.sign(power);
      await this.setCapabilityValue('measure_power', nudged).catch(this.error);
    }

    await this.setCapabilityValue('measure_power', power).catch(this.error);
  }

  async setEnergyCapability(capability, wh, decimals) {
    if (typeof wh !== 'number') return;

    if (!this.hasCapability(capability)) {
      await this.addCapability(capability);
    }

    const scale = 10 ** decimals;
    await this.setCapabilityValue(capability, Math.round((wh / 1000) * scale) / scale).catch(this.error);
  }

  async updateReserve() {
    if (Date.now() - this.lastReserveUpdate < this.constructor.RESERVE_REFRESH_AFTER) return;

    const { backupReserve } = await this.api.getSiteDetails({ siteId: this.getData().siteId });
    this.lastReserveUpdate = Date.now();
    if (typeof backupReserve === 'number') {
      await this.setCapabilityValue('battery_backup_reserve', backupReserve).catch(this.error);
    }
  }

  // Installation date and rated capacity. Neither changes, so they are fetched
  // once and kept in the store.
  async getSiteInfo() {
    let site = this.getStoreValue('siteInfo');
    if (site) return site;

    const { siteId } = this.getData();
    const [details, equipment] = await Promise.all([
      this.api.getSiteDetails({ siteId }),
      this.api.getSiteEquipment({ siteId }),
    ]);

    const capacityKwh = (equipment.storage?.details ?? [])
      .reduce((total, battery) => total + (battery.capacity ?? 0), 0);

    site = {
      installationDate: details.installationDate.slice(0, 10),
      ratedWh: capacityKwh > 0 ? capacityKwh * 1000 : null,
    };

    await this.setStoreValue('siteInfo', site);
    return site;
  }

  // Once a day, adds yesterday's discharge stretches to the rolling window and
  // re-estimates state of health from it. See lib/BatteryHealth.mjs.
  async updateHealth({ site, today, lifetime }) {
    const yesterday = addDays(today, -1);
    const hour = Number(localDateTime(new Date(), this.homey.clock.getTimezone()).slice(11, 13));

    if (this.getStoreValue('healthDate') === yesterday
      || hour < this.constructor.HEALTH_AFTER_HOUR
      || Date.now() - this.lastHealthAttempt < this.constructor.HEALTH_RETRY_AFTER) {
      return;
    }

    this.lastHealthAttempt = Date.now();

    const { siteId } = this.getData();
    const [soc, energy] = await Promise.all([
      this.api.getBatteryStateOfCharge({ siteId, date: yesterday }),
      this.api.getSiteEnergy({
        siteId,
        startDate: yesterday,
        endDate: yesterday,
        timeUnit: 'quarter-hours',
        measurementTypes: ['consumption', 'consumption-distribution-with-storage'],
      }),
    ]);

    const fresh = dischargeSegments(buildSlots(soc.measurements ?? [], energy.chart?.measurements ?? []))
      .map((segment) => ({ ...segment, date: yesterday }));

    const windowStart = addDays(today, -this.constructor.HEALTH_WINDOW_DAYS);
    const segments = [
      ...(this.getStoreValue('healthSegments') ?? []).filter((segment) => segment.date >= windowStart && segment.date !== yesterday),
      ...fresh,
    ];

    await this.setStoreValue('healthSegments', segments);
    await this.setStoreValue('healthDate', yesterday);

    const efficiency = dischargeEfficiency(lifetime.sources?.total, lifetime.destinations?.total);
    const soh = stateOfHealth(estimateFullPackWh(segments), site.ratedWh, { efficiency });
    this.log(`Battery health: ${fresh.length} discharge stretches yesterday, ${segments.length} in window, discharge efficiency ${efficiency.toFixed(3)}, SoH ${soh ?? 'not enough data'}`);

    if (soh !== null) {
      await this.setCapabilityValue('battery_soh', soh).catch(this.error);
    }
  }

}
