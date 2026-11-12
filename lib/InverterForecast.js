/*
Copyright 2026, John Bothe

This file is part of com.solaredge.

com.solaredge is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.solaredge is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.solaredge.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

/*
 * The solar forecast of an inverter device (drivers/inverter/device.js): the SolarForecaster of its
 * site, its capabilities, the accuracy label in its settings and the 'tomorrow' Flow trigger.
 *
 * The forecast is of the whole site (its peak power, production and location), so on a site with
 * several inverter devices only one runs it: the site device, or the inverter with the lowest
 * serial. Only that device gets the forecast capabilities (recordSeenCaps), so the Flow cards
 * (device filter capabilities=) list only it.
 *
 * What the forecast learnt is kept in the device store, under the keys of the fork that built it
 * (forecastHistory, forecastProfile, forecastCalibration, forecastLog, forecastTodayBaseline), so
 * devices that ran it there keep their history.
 */

const SolarForecaster = require('./SolarForecaster');
const OpenMeteoClient = require('./OpenMeteoClient');
const { describePlanes, planesFromGroups } = require('./panelLayout');
const {
  MIN_ACCURACY_DAYS, ACCURACY_DAYS, accuracyPercent, dayAheadEntry, recordDayAhead, scoreForecasts,
} = require('./forecastAccuracy');
const { todayProgress } = require('./todayProgress');
const {
  addDays, daysBetween, localDate, localDateTime,
} = require('./localDate');

// the capabilities of the device that runs the forecast, all added at once
const CAPABILITIES = ['solar_forecast_power', 'solar_forecast_today', 'solar_forecast_tomorrow', 'solar_forecast_vs_actual',
  'solar_forecast_projected', 'solar_forecast_remaining', 'solar_forecast_accuracy'];

// Updates "expected power now" from the cached forecast. Only refreshes, recalibrations and profile
// rebuilds make network calls.
const TICK_INTERVAL = 15 * 60 * 1000;
const REFRESH_AFTER = 60 * 60 * 1000;
// once a day, after 01:00 so yesterday's production is final
const CALIBRATE_AFTER_HOUR = 1;
// a failing calibration is not retried on every tick: each attempt makes a handful of SolarEdge requests
const CALIBRATE_RETRY_AFTER = 60 * 60 * 1000;
// the seasonal profile moves slowly; a month-old one is still good
const PROFILE_MAX_AGE_DAYS = 30;
const PROFILE_RETRY_AFTER = 6 * 60 * 60 * 1000;

const toKwh = (wh) => (wh === null ? null : Math.round(wh / 100) / 10);

class InverterForecast {

  static CAPABILITIES = CAPABILITIES;

  static TICK_INTERVAL = TICK_INTERVAL;

  /**
   * Planes from the up to three panel groups in the settings. SolarEdge's site layout is not used:
   * it is the installer's drawing, and on the author's site it did not match the roof
   * (lib/panelLayout.js).
   * @throws {Error} with `code` FORECAST_FIRST_GROUP when the groups do not add up
   */
  static panelPlanes(settings) {
    const group = (suffix) => {
      const orientation = settings[`forecast_orientation${suffix}`];
      return {
        panels: settings[`forecast_panels${suffix}`] ?? 0,
        tilt: settings[`forecast_tilt${suffix}`] ?? 20,
        // compass degrees; 'auto' faces the equator
        azimuth: orientation && orientation !== 'auto' ? Number(orientation) : null,
      };
    };
    return planesFromGroups([group(''), group('_2'), group('_3')]);
  }

  /** @param {Homey.Device} device the inverter device */
  constructor(device, { openMeteo } = {}) {
    this.device = device;
    this.homey = device.homey;
    this.openMeteo = openMeteo || new OpenMeteoClient({ log: (...args) => device.log(...args) });
    this.forecaster = null;
    this.forecast = null;
    this.fetchedAt = 0;
    this.forecastDate = null;
    this.calibrationAttempt = 0;
    this.profileAttempt = 0;
    this.running = false;
    this.accuracyDate = null;
    this.produced = null;
    this.pendingSettings = null;
  }

  start() {
    this.stop();
    this.timer = this.homey.setInterval(() => this.tick(), TICK_INTERVAL);
    this.tick();
  }

  stop() {
    if (this.timer) this.homey.clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    this.update().catch((error) => this.device.error(`Error updating forecast: ${error.message}`));
  }

  /** Before the settings are saved: rejects panel groups that do not add up, with the reason. */
  checkSettings(newSettings, changedKeys) {
    if (!this.forecastSettingsChanged(changedKeys)) return;
    try {
      InverterForecast.panelPlanes(newSettings);
    } catch (error) {
      if (error.code === 'FORECAST_FIRST_GROUP') throw new Error(this.homey.__('errors.forecastFirstGroup'));
      throw error;
    }
  }

  /** forecast_accuracy is a label the app writes; it changing is no reason to rebuild anything. */
  forecastSettingsChanged(changedKeys) {
    return changedKeys.some((key) => key.startsWith('forecast_') && key !== 'forecast_accuracy');
  }

  /** After checkSettings: the forecaster is rebuilt from the new settings. */
  settingsChanged(newSettings, changedKeys) {
    if (!this.forecastSettingsChanged(changedKeys)) return;
    // Homey saves the settings only after onSettings returns: getSettings() still has the old ones
    this.pendingSettings = newSettings;
    // the stored profile and calibration are keyed on their config: rebuilt on the next tick
    this.forecaster = null;
    this.forecast = null;
    this.calibrationAttempt = 0;
    this.profileAttempt = 0;
    this.tick();
  }

  /** Today's production of the whole site so far (Wh), as the energy poll reads it. */
  async noteProduced(date, wh) {
    this.produced = { date, wh };
    // fresh production: the comparison is brought up to date now rather than at the next tick
    if (this.forecast && this.isForecaster) await this.setTodayProgress(new Date());
  }

  /** Whether this device runs its site's forecast. */
  async runsForecast() {
    const { device } = this;
    if (await device.wholeSite()) return true;
    const serials = [...await device.inverterSerials()].sort();
    return serials.length > 0 && device.serial === serials[0];
  }

  async getForecaster() {
    if (this.forecaster) return this.forecaster;
    const { device } = this;
    const settings = this.pendingSettings ?? device.getSettings();
    this.pendingSettings = null;
    this.timeZone = await device.siteTimeZone();

    // location and peak power from the site's details in SolarEdge
    const forecaster = new SolarForecaster({
      client: device.client,
      openMeteo: this.openMeteo,
      siteId: device.getData().siteId,
      timeZone: this.timeZone,
      planes: InverterForecast.panelPlanes(settings),
      // the SolarEdge history the forecast learns from, kept across restarts so they don't fetch it
      // again (about 100 bytes a day, a year and a month of it)
      historyStore: {
        load: async () => device.getStoreValue('forecastHistory'),
        save: async (history) => device.setStoreValue('forecastHistory', history),
      },
    });
    await forecaster.init();
    device.log(`Forecast panels: ${describePlanes(forecaster.location.planes)} (tilt/facing)`);
    this.forecaster = forecaster;
    return forecaster;
  }

  needsProfile(profile, forecaster, today) {
    return !profile
      || profile.version !== SolarForecaster.PROFILE_VERSION
      || profile.configKey !== forecaster.configKey
      || daysBetween(profile.date, today) >= PROFILE_MAX_AGE_DAYS;
  }

  needsCalibration(calibration, forecaster, profile, now) {
    if (!calibration || calibration.configKey !== forecaster.configKey || calibration.profileDate !== (profile?.date ?? null)) return true;
    const hour = Number(localDateTime(now, this.timeZone).slice(11, 13));
    return calibration.date !== localDate(now, this.timeZone) && hour >= CALIBRATE_AFTER_HOUR;
  }

  async update() {
    if (this.running) return;
    this.running = true;
    const { device } = this;
    try {
      if (!device.client) return;
      this.isForecaster = await this.runsForecast();
      if (!this.isForecaster) return;
      const forecaster = await this.getForecaster();

      const now = new Date();
      const today = localDate(now, this.timeZone);

      // a failed rebuild keeps the previous profile: an old one still beats none, and none just
      // means no seasonal adjustment
      let profile = device.getStoreValue('forecastProfile');
      if (this.needsProfile(profile, forecaster, today) && now - this.profileAttempt > PROFILE_RETRY_AFTER) {
        this.profileAttempt = now.getTime();
        try {
          profile = await forecaster.buildProfile({ now });
          await device.setStoreValue('forecastProfile', profile);
          device.log(`Forecast profile built: seasonal from ${profile.days} days${profile.multipliers ? '' : ' (too few, not used)'}, `
            + `shading ${profile.shading ? `from ${profile.shading.days} days` : 'not enough hourly history'}`);
        } catch (error) {
          device.error(`Error building forecast profile: ${error.message}`);
        }
      }

      let calibration = device.getStoreValue('forecastCalibration');
      if (this.needsCalibration(calibration, forecaster, profile, now) && now - this.calibrationAttempt > CALIBRATE_RETRY_AFTER) {
        this.calibrationAttempt = now.getTime();
        calibration = await forecaster.calibrate({ now, profile });
        await device.setStoreValue('forecastCalibration', calibration);
        this.forecast = null;
        device.log(`Forecast calibrated: factor ${calibration.factor} from ${calibration.days} days${calibration.calibrated ? '' : ' (too few, using default)'}`);
      }

      // a stale calibration from yesterday still beats no forecast at all
      if (!calibration) return;

      // fetched again on a new day too, or 'tomorrow' would read as the day after the cached one
      if (!this.forecast || this.forecastDate !== today || now - this.fetchedAt > REFRESH_AFTER) {
        this.forecast = await forecaster.forecast({ calibration, profile });
        this.fetchedAt = now.getTime();
        this.forecastDate = today;
        await this.recordDayAhead(today);
      }

      // the forecast tiles, all at once: one capability migration
      await device.recordSeenCaps(Object.fromEntries(CAPABILITIES.map((capability) => [capability, true])));
      await this.setForecastCapabilities(now);

      // its own failures do not stop the forecast
      await this.updateAccuracy(forecaster, today).catch((error) => device.error(`Error scoring the forecast: ${error.message}`));
    } finally {
      this.running = false;
    }
  }

  /**
   * Keeps tomorrow's forecast for scoring once tomorrow is over. Each refresh replaces the last, so
   * the one kept is the last made before the day: the day-ahead forecast.
   */
  async recordDayAhead(today) {
    const { device } = this;
    // today's plan for "today vs forecast" is last night's day-ahead forecast; on a day without one
    // (just installed, say) the first forecast made today stands in
    const baseline = device.getStoreValue('forecastTodayBaseline');
    const todayForecast = this.forecast?.days?.[today];
    if (todayForecast && !device.getStoreValue('forecastLog')?.[today] && baseline?.date !== today) {
      await device.setStoreValue('forecastTodayBaseline', { date: today, hours: dayAheadEntry(today, todayForecast, this.forecast.hours).hours });
    }

    const tomorrow = addDays(today, 1);
    const day = this.forecast?.days?.[tomorrow];
    if (!day) return;
    const log = recordDayAhead(device.getStoreValue('forecastLog'), tomorrow, dayAheadEntry(tomorrow, day, this.forecast.hours));
    await device.setStoreValue('forecastLog', log);
  }

  /**
   * Once a day, scores the last ACCURACY_DAYS of day-ahead forecasts against production (from the
   * forecaster's history, so no extra requests) and shows the result.
   */
  async updateAccuracy(forecaster, today) {
    if (this.accuracyDate === today) return;
    const { device } = this;

    const endDate = addDays(today, -1);
    const range = { startDate: addDays(endDate, -(ACCURACY_DAYS - 1)), endDate };
    const energy = Object.fromEntries((await forecaster.getEnergy(range)).map(({ date, value }) => [date, value]));
    const power = await forecaster.getPowerDays(range);

    const log = device.getStoreValue('forecastLog') ?? {};
    const score = scoreForecasts(log, { energy, power }, { endDate });
    this.accuracyDate = today;

    const pct = (fraction) => Math.round(fraction * 100);
    const details = score
      ? this.homey.__('forecast.accuracySummary', {
        accuracy: accuracyPercent(score),
        days: score.days,
        error: pct(score.error),
        bias: `${score.bias >= 0 ? '+' : ''}${pct(score.bias)}`,
        coverage: pct(score.coverage),
        hourly: score.hourlyError === null ? '–' : pct(score.hourlyError),
      })
      : this.homey.__('forecast.accuracyPending', {
        needed: MIN_ACCURACY_DAYS,
        days: Object.keys(log).filter((date) => date <= endDate && date >= range.startDate).length,
      });

    await device.setCapability('solar_forecast_accuracy', accuracyPercent(score));
    await device.setSettings({ forecast_accuracy: details }).catch((error) => device.error(error));
    device.log(`Forecast accuracy: ${details}`);
  }

  /** Today and tomorrow (P10/P50/P90 in Wh) and the expected power now. */
  summary(now = new Date()) {
    if (!this.forecast) throw new Error(this.homey.__('forecast.notReady'));
    return SolarForecaster.summarise(this.forecast, { now, timeZone: this.timeZone });
  }

  /** The expected power at the next time the clock reads `clock` ('HH:MM'), for the Flow condition. */
  expectedPowerAt(clock) {
    if (!this.forecast) throw new Error(this.homey.__('forecast.notReady'));
    const at = SolarForecaster.nextOccurrence(clock, { timeZone: this.timeZone });
    return SolarForecaster.expectedPowerAt(this.forecast, { at, timeZone: this.timeZone });
  }

  /** Today vs forecast, projected today and remaining today. */
  async setTodayProgress(now) {
    const { device } = this;
    const today = localDate(now, this.timeZone);
    const clock = localDateTime(now, this.timeZone).slice(11, 16);

    const baseline = device.getStoreValue('forecastTodayBaseline');
    const planHours = device.getStoreValue('forecastLog')?.[today]?.hours ?? (baseline?.date === today ? baseline.hours : null);
    const latest = this.forecast?.days?.[today];
    const latestHours = latest ? dayAheadEntry(today, latest, this.forecast.hours).hours : null;
    // only once the energy poll has read today's production: just after midnight it still holds yesterday's
    const producedWh = this.produced?.date === today ? this.produced.wh : null;

    const progress = todayProgress({
      planHours,
      latestHours,
      producedWh,
      at: { hour: Number(clock.slice(0, 2)), minute: Number(clock.slice(3, 5)) },
    });

    await device.setCapability('solar_forecast_vs_actual', progress.vsForecast === null ? null : Math.round(progress.vsForecast * 100));
    await device.setCapability('solar_forecast_projected', toKwh(progress.projectedWh));
    await device.setCapability('solar_forecast_remaining', toKwh(progress.remainingWh));
  }

  async setForecastCapabilities(now) {
    const { device } = this;
    const { today, tomorrow, powerNowW } = this.summary(now);
    const tomorrowKwh = toKwh(tomorrow.p50);
    const previousTomorrowKwh = device.getCapabilityValue('solar_forecast_tomorrow');

    await device.setCapability('solar_forecast_power', Math.round(powerNowW));
    await device.setCapability('solar_forecast_today', toKwh(today.p50));
    await device.setCapability('solar_forecast_tomorrow', tomorrowKwh);
    await this.setTodayProgress(now);

    // Not a '<capability>_changed' card: Homey runs those itself, with only the capability's value
    if (tomorrowKwh !== previousTomorrowKwh) {
      await this.homey.flow.getDeviceTriggerCard('solar_forecast_tomorrow_updated')
        .trigger(device, { forecast: tomorrowKwh, forecast_low: toKwh(tomorrow.p10), forecast_high: toKwh(tomorrow.p90) })
        .catch((error) => device.error(error));
    }
  }

}

module.exports = InverterForecast;
