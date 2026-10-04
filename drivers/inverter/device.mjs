import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';
import SolarForecaster from '../../lib/SolarForecaster.mjs';
import { daysBetween, localDate, localDateTime } from '../../lib/SolarForecastModel.mjs';

export default class SolarEdgeDeviceInverter extends SolarEdgeDevice {

  // Read from the V1 API's inverter telemetry, which SolarEdge retired on
  // 2026-11-03. Nothing a homeowner login can reach reports them any more.
  static RETIRED_CAPABILITIES = ['measure_temperature', 'measure_voltage', 'measure_voltage.dc'];

  // Updates "expected power now" from the cached forecast. Only refreshes,
  // recalibrations and profile rebuilds make network calls.
  static FORECAST_INTERVAL = 1000 * 60 * 15; // 15 mins

  static FORECAST_REFRESH_AFTER = 1000 * 60 * 60; // 1 hour

  // Recalibrate once a day, after 01:00 so yesterday's production is final.
  static CALIBRATE_AFTER_HOUR = 1;

  // A failing calibration must not be retried on every tick: each attempt
  // makes a handful of SolarEdge requests.
  static CALIBRATE_RETRY_AFTER = 1000 * 60 * 60; // 1 hour

  // The seasonal profile moves slowly; a month-old one is still good.
  static PROFILE_MAX_AGE_DAYS = 30;

  static PROFILE_RETRY_AFTER = 1000 * 60 * 60 * 6; // 6 hours

  async onInit() {
    // Adds the forecast capabilities to devices paired before them, and puts
    // everything in the manifest's order (power, forecasts, then today, month,
    // year and total produced) for devices that gained capabilities at
    // runtime.
    await this.orderCapabilities(this.driver.manifest.capabilities);

    await super.onInit();

    this.forecaster = null;
    this.forecast = null;
    this.forecastFetchedAt = 0;
    this.forecastDate = null;
    this.lastCalibrationAttempt = 0;
    this.lastProfileAttempt = 0;
    this.forecasting = false;

    this.forecastInterval = setInterval(() => this.forecastTick(), this.constructor.FORECAST_INTERVAL);
    this.forecastTick();
  }

  async onUninit() {
    if (this.forecastInterval) {
      clearInterval(this.forecastInterval);
    }

    await super.onUninit();
  }

  async onSettings({ newSettings, changedKeys }) {
    await super.onSettings({ newSettings, changedKeys });

    if (changedKeys.some((key) => ['forecast_tilt', 'forecast_orientation'].includes(key))) {
      // The stored profile and calibration are keyed on their config, so
      // they are rebuilt on the next tick rather than discarded here.
      this.forecaster = null;
      this.forecast = null;
      this.lastCalibrationAttempt = 0;
      this.lastProfileAttempt = 0;
      this.forecastTick();
    }
  }

  forecastTick() {
    this.updateForecast().catch((err) => {
      this.error(`Error updating forecast: ${err.message}`);
    });
  }

  async getForecaster() {
    if (this.forecaster) return this.forecaster;

    const { forecast_tilt: tilt, forecast_orientation: orientation } = this.getSettings();

    // Location comes from the site's coordinates in SolarEdge.
    const forecaster = new SolarForecaster({
      solarEdgeApi: this.api,
      siteId: this.getData().siteId,
      timeZone: this.homey.clock.getTimezone(),
      tilt: tilt ?? 20,
      // Compass degrees; left out, the panels are taken to face the equator.
      azimuth: orientation && orientation !== 'auto' ? Number(orientation) : undefined,
      // SolarEdge history the forecast learns from, kept across restarts so
      // they don't refetch it (about 100 bytes a day, a year and a month of
      // it).
      historyStore: {
        load: async () => this.getStoreValue('forecastHistory'),
        save: async (history) => this.setStoreValue('forecastHistory', history),
      },
    });

    await forecaster.init();
    this.forecaster = forecaster;
    return forecaster;
  }

  needsProfile(profile, forecaster, today) {
    return !profile
      || profile.version !== SolarForecaster.PROFILE_VERSION
      || profile.configKey !== forecaster.configKey
      || daysBetween(profile.date, today) >= this.constructor.PROFILE_MAX_AGE_DAYS;
  }

  needsCalibration(calibration, forecaster, profile, now) {
    if (!calibration
      || calibration.configKey !== forecaster.configKey
      || calibration.profileDate !== (profile?.date ?? null)) {
      return true;
    }

    const timeZone = this.homey.clock.getTimezone();
    const hour = Number(localDateTime(now, timeZone).slice(11, 13));
    return calibration.date !== localDate(now, timeZone) && hour >= this.constructor.CALIBRATE_AFTER_HOUR;
  }

  async updateForecast() {
    if (this.forecasting) return;
    this.forecasting = true;

    try {
      // Shares the device's session with the long poll. A 401 clears it, and
      // this logs in again on the next tick.
      await this.ensureSignedIn();
      const forecaster = await this.getForecaster();

      const now = new Date();
      const timeZone = this.homey.clock.getTimezone();
      const today = localDate(now, timeZone);

      // A failed rebuild keeps the previous profile: an old one still beats
      // none, and none just means no seasonal adjustment.
      let profile = this.getStoreValue('forecastProfile');
      if (this.needsProfile(profile, forecaster, today)
        && now - this.lastProfileAttempt > this.constructor.PROFILE_RETRY_AFTER) {
        this.lastProfileAttempt = now.getTime();
        try {
          profile = await forecaster.buildProfile({ now });
          await this.setStoreValue('forecastProfile', profile);
          this.log(`Forecast profile built: seasonal from ${profile.days} days${profile.multipliers ? '' : ' (too few, not used)'}, `
            + `shading ${profile.shading ? `from ${profile.shading.days} days` : 'not enough hourly history'}`);
        } catch (err) {
          this.error(`Error building forecast profile: ${err.message}`);
        }
      }

      let calibration = this.getStoreValue('forecastCalibration');
      if (this.needsCalibration(calibration, forecaster, profile, now)
        && now - this.lastCalibrationAttempt > this.constructor.CALIBRATE_RETRY_AFTER) {
        this.lastCalibrationAttempt = now.getTime();
        calibration = await forecaster.calibrate({ now, profile });
        await this.setStoreValue('forecastCalibration', calibration);
        this.forecast = null;
        this.log(`Forecast calibrated: factor ${calibration.factor} from ${calibration.days} days${calibration.calibrated ? '' : ' (too few, using default)'}`);
      }

      // A stale calibration from yesterday still beats no forecast at all.
      if (!calibration) return;

      // Refetch on a new day too, or "tomorrow" would read as the day after
      // the cached forecast ends.
      if (!this.forecast
        || this.forecastDate !== today
        || now - this.forecastFetchedAt > this.constructor.FORECAST_REFRESH_AFTER) {
        this.forecast = await forecaster.forecast({ calibration, profile });
        this.forecastFetchedAt = now.getTime();
        this.forecastDate = today;
      }

      await this.setForecastCapabilities(now);
    } finally {
      this.forecasting = false;
    }
  }

  getForecastSummary(now = new Date()) {
    if (!this.forecast) {
      throw new Error(this.homey.__('forecast.notReady'));
    }

    return SolarForecaster.summarise(this.forecast, { now, timeZone: this.homey.clock.getTimezone() });
  }

  // For the "expected power at" condition card. clock is 'HH:MM'.
  getExpectedPowerAt(clock) {
    if (!this.forecast) {
      throw new Error(this.homey.__('forecast.notReady'));
    }

    const timeZone = this.homey.clock.getTimezone();
    const at = SolarForecaster.nextOccurrence(clock, { timeZone });
    return SolarForecaster.expectedPowerAt(this.forecast, { at, timeZone });
  }

  async setForecastCapabilities(now) {
    const { today, tomorrow, powerNowW } = this.getForecastSummary(now);
    const toKwh = (wh) => Math.round(wh / 100) / 10;

    const tomorrowKwh = toKwh(tomorrow.p50);
    const previousTomorrowKwh = this.getCapabilityValue('solar_forecast_tomorrow');

    await this.setCapabilityValue('solar_forecast_power', Math.round(powerNowW)).catch(this.error);
    await this.setCapabilityValue('solar_forecast_today', toKwh(today.p50)).catch(this.error);
    await this.setCapabilityValue('solar_forecast_tomorrow', tomorrowKwh).catch(this.error);

    if (tomorrowKwh !== previousTomorrowKwh) {
      await this.homey.flow
        .getDeviceTriggerCard('solar_forecast_tomorrow_changed')
        .trigger(this, {
          forecast: tomorrowKwh,
          forecast_low: toKwh(tomorrow.p10),
          forecast_high: toKwh(tomorrow.p90),
        })
        .catch(this.error);
    }
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
