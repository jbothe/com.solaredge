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

const OpenMeteoClient = require('./OpenMeteoClient');
const { addDays, localDate, localDateTime } = require('./localDate');
const {
  CEILING_DAYS, alignedBlocks, applyBands, buildSeasonalProfile, buildShadingProfile, fitBands, fitCeiling, fitFactor,
  predictDay, predictHourWh, seasonalMultiplier, shadingMultipliers, summariseDays,
} = require('./solarForecastModel');

// Fetches what the model needs and runs it. Deliberately free of Homey, so it
// runs in plain Node (test/forecast.js).
//
// SolarEdge data comes from the web portal's services/dashboard endpoints
// (SolarEdgeCloudClient getSiteDetails, getSiteEnergyChart, getSitePowerChart,
// on the account's Bearer token), which have no published quota but shouldn't
// be hammered. History is
// kept per date in historyStore (the device store in the app): daily energy, and 15-minute PV power rolled up into energy per
// hour plus the day's peak. Only dates it lacks are fetched, in fixed blocks
// (calendar months of energy, weeks of power), so after the first run (about
// 13 energy and 53 power requests for a year) a day costs about 2, restarts
// included. forecast() makes none.
class SolarForecaster {

  // Days the factor is fitted over.
  static CALIBRATION_DAYS = 60;

  // Days of history for the seasonal profile and the forecast range.
  static HISTORY_DAYS = 365;

  // Days of 15-minute power history used to find the inverter's clipping
  // limit.
  static MAX_POWER_DAYS = 28;

  // Block sizes, inside the dashboard endpoints' request limits (about three
  // months of daily energy, eight days of 15-minute power).
  static ENERGY_BLOCK = 'month';

  static POWER_BLOCK_DAYS = 7;

  // Headroom over the highest power seen, so an unusually clear day isn't
  // clipped just because the last four weeks never hit the real limit.
  static CAP_HEADROOM = 1.05;

  // Dates older than this are dropped from the history: a month more than the
  // profile needs.
  static RETAIN_DAYS = 365 + 31;

  // A date that came back without data is asked for again while it's this
  // recent, since data can arrive late after a communication outage.
  static RECHECK_MISSING_DAYS = 7;

  // Bumped whenever the profile's shape changes, so stored ones are rebuilt.
  static PROFILE_VERSION = 2;

  // latitude and longitude are optional: SolarEdge knows where most sites
  // are, and its coordinates are used when these are left out.
  constructor({
    client,
    openMeteo = new OpenMeteoClient(),
    siteId,
    timeZone,
    latitude,
    longitude,
    tilt,
    azimuth,
    // [{ tilt, azimuth, share }]: panel groups facing different ways, each
    // forecast separately and weighted by share. Overrides tilt/azimuth.
    planes,
    // { load: async () => history | null, save: async (history) => {} }.
    // Without one, history lasts as long as this instance.
    historyStore = null,
    retainDays = SolarForecaster.RETAIN_DAYS,
    now = () => new Date(),
  }) {
    this.client = client;
    this.openMeteo = openMeteo;
    this.siteId = siteId;
    this.timeZone = timeZone;
    this.requested = {
      latitude, longitude, tilt, azimuth, planes,
    };

    this.historyStore = historyStore;
    this.retainDays = retainDays;
    this.now = now;

    this.location = null;
    this.peakPowerW = null;
    this.history = null;
    this.inFlight = new Map();
  }

  async init() {
    if (this.location) return;

    const details = await this.client.getSiteDetails({ siteId: this.siteId });

    this.peakPowerW = details?.peakPower > 0 ? details.peakPower * 1000 : null;
    if (!this.peakPowerW) {
      throw new Error('SolarEdge did not report the site\'s peak power');
    }

    const latitude = this.requested.latitude ?? Number(details.latitude);
    const longitude = this.requested.longitude ?? Number(details.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('SolarEdge did not report the site\'s location');
    }

    // Panels face the equator unless told otherwise.
    const equator = latitude < 0 ? 0 : 180;
    const planes = (this.requested.planes ?? [{ tilt: this.requested.tilt, azimuth: this.requested.azimuth, share: 1 }])
      .map((plane) => ({ ...plane, azimuth: plane.azimuth ?? equator }));

    this.location = {
      latitude,
      longitude,
      planes,
      timeZone: this.timeZone,
    };
  }

  // Changes to any of these invalidate a profile or calibration, since both
  // were fitted against irradiance computed from them.
  get configKey() {
    const { latitude, longitude, planes } = this.location;
    return [
      latitude.toFixed(3),
      longitude.toFixed(3),
      ...planes.map((p) => `${p.tilt}/${p.azimuth}/${p.share.toFixed(3)}`),
    ].join('|');
  }

  // Open-Meteo hours for the site, from one request per plane with each
  // plane's irradiance weighted by its share. method is an OpenMeteoClient
  // method taking { latitude, longitude, tilt, azimuth, timeZone, ... }.
  async getHours(method, params) {
    const {
      latitude, longitude, timeZone, planes,
    } = this.location;

    const perPlane = await Promise.all(planes.map((plane) => this.openMeteo[method]({
      latitude, longitude, timeZone, tilt: plane.tilt, azimuth: plane.azimuth, ...params,
    })));

    if (perPlane.length === 1) return perPlane[0];

    // Cell temperature depends on irradiance too, but blending the
    // irradiance and computing one ideal output from it is within a fraction
    // of a percent of blending the outputs.
    return perPlane[0].map((hour, i) => {
      let gti = 0;
      for (const [p, hours] of perPlane.entries()) {
        const value = hours[i]?.time === hour.time ? hours[i].gti : null;
        if (typeof value !== 'number') return { ...hour, gti: null };
        gti += value * planes[p].share;
      }
      return { ...hour, gti };
    });
  }

  // { siteId, energy: { date: Wh | null }, power: { date: { hours, maxW } | null } },
  // where hours is the energy (Wh) in each hour of the day, indexed by the
  // hour it *ends* (Open-Meteo's convention), and maxW the highest 15-minute
  // power. null marks a date SolarEdge had nothing for.
  async loadHistory() {
    if (!this.history) {
      const stored = await this.historyStore?.load();
      this.history = stored?.siteId === String(this.siteId)
        ? stored
        : { siteId: String(this.siteId), energy: {}, power: {} };
    }
    return this.history;
  }

  async saveHistory(today) {
    const oldest = addDays(today, -this.retainDays);
    for (const kind of ['energy', 'power']) {
      for (const date of Object.keys(this.history[kind])) {
        if (date < oldest) delete this.history[kind][date];
      }
    }
    await this.historyStore?.save(this.history);
  }

  // Fills in the dates of the range that the history lacks, block by block,
  // and returns { date: value } for the range. fetchBlock resolves to
  // { date: value } for its block. Only finished days (before today) are
  // kept, so a partial day is never mistaken for a whole one.
  //
  // A caller arriving while a block is in flight waits for it rather than
  // fetching it again. That happens when a failed Open-Meteo request rejects
  // loadDays()'s Promise.all and the next step asks for the same year while
  // this is still running.
  async ensureHistory(kind, { startDate, endDate, unit }, fetchBlock) {
    const store = (await this.loadHistory())[kind];
    const today = localDate(this.now(), this.timeZone);
    const recheckFrom = addDays(today, -SolarForecaster.RECHECK_MISSING_DAYS);
    const isMissing = (date) => !(date in store) || (store[date] === null && date >= recheckFrom);

    let fetched = false;
    for (const block of alignedBlocks(startDate, endDate, unit)) {
      const dates = [];
      for (let date = block.startDate; date <= block.endDate && date < today; date = addDays(date, 1)) dates.push(date);
      if (!dates.some(isMissing)) continue;

      const key = `${kind}|${block.startDate}|${block.endDate}`;
      let pending = this.inFlight.get(key);
      if (!pending) {
        pending = fetchBlock(block).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, pending);
      }

      // One block at a time, to go easy on SolarEdge.
      const byDate = await pending;
      for (const date of dates) store[date] = byDate[date] ?? null;
      fetched = true;
    }

    if (fetched) await this.saveHistory(today);

    const range = {};
    for (let date = startDate; date <= endDate; date = addDays(date, 1)) range[date] = store[date] ?? null;
    return range;
  }

  // Daily PV production as [{ date, value }] in Wh, value null where
  // SolarEdge has none.
  async getEnergy({ startDate, endDate }) {
    const byDate = await this.ensureHistory('energy', { startDate, endDate, unit: SolarForecaster.ENERGY_BLOCK }, async (block) => {
      const { chart } = await this.client.getSiteEnergyChart({
        siteId: this.siteId, timeUnit: 'days', measurementTypes: ['production'], ...block,
      });
      return Object.fromEntries((chart?.measurements ?? [])
        .filter((m) => typeof m.production === 'number')
        .map((m) => [m.measurementTime.slice(0, 10), Math.round(m.production)]));
    });

    return Object.entries(byDate).map(([date, value]) => ({ date, value }));
  }

  // { date: { hours, maxW } | null }, from 15-minute PV power.
  async getPowerDays({ startDate, endDate }) {
    return this.ensureHistory('power', { startDate, endDate, unit: SolarForecaster.POWER_BLOCK_DAYS }, async (block) => {
      const { measurements } = await this.client.getSitePowerChart({
        siteId: this.siteId, timeUnit: 'quarter-hours', measurementTypes: ['production'], ...block,
      });
      return SolarForecaster.rollUpPower(measurements ?? []);
    });
  }

  // 15-minute power samples ([{ measurementTime, production }], W, stamped at
  // the start of their window) to { date: { hours, maxW } }. A sample
  // starting at 10:15 is energy in the hour ending 11:00, so it lands in
  // hours[11]. Samples from 23:00 would belong to the next day's hour 0;
  // they're always dark, so they're dropped.
  static rollUpPower(measurements) {
    const days = {};

    for (const { measurementTime, production } of measurements) {
      if (typeof production !== 'number') continue;

      const date = measurementTime.slice(0, 10);
      const hour = Number(measurementTime.slice(11, 13)) + 1;
      days[date] ??= { hours: new Array(24).fill(0), maxW: 0 };
      if (hour < 24) days[date].hours[hour] += production / 4;
      days[date].maxW = Math.max(days[date].maxW, production);
    }

    for (const day of Object.values(days)) {
      day.hours = day.hours.map(Math.round);
      day.maxW = Math.round(day.maxW);
    }

    return days;
  }

  // The inverter's clipping limit, from the highest 15-minute power in the
  // four weeks up to endDate.
  async getCapW({ endDate }) {
    const startDate = addDays(endDate, -(SolarForecaster.MAX_POWER_DAYS - 1));
    const days = Object.values(await this.getPowerDays({ startDate, endDate })).filter(Boolean);
    const maxW = Math.max(0, ...days.map((day) => day.maxW));
    return maxW > 0 ? maxW * SolarForecaster.CAP_HEADROOM : null;
  }

  // A day with the seasonal multiplier for its date attached. The shading
  // profile only shapes forecast days (see forecast()), so it isn't applied
  // here.
  static withProfile(day, profile) {
    return { ...day, multiplier: seasonalMultiplier(profile, day.date) };
  }

  // [{ date, actualWh, idealHours, hourOfDay, cloudHours, cloudCover,
  // multiplier, actualHours? }] for every day in the range
  // that has both a SolarEdge reading and weather. weather is 'dayAhead'
  // (what was forecast the day before) or 'archive' (close to what actually
  // happened). withHours adds actualHours, the hourly production.
  async loadDays({
    startDate, endDate, weather, profile, withHours = false,
  }) {
    await this.init();

    const method = weather === 'archive' ? 'getHistoricalForecast' : 'getDayAheadHistory';

    const [energy, hours] = await Promise.all([
      this.getEnergy({ startDate, endDate }),
      this.getHours(method, { startDate, endDate }),
    ]);
    const power = withHours ? await this.getPowerDays({ startDate, endDate }) : null;

    const days = summariseDays(hours, this.peakPowerW);

    return energy
      .filter(({ date, value }) => typeof value === 'number' && days[date])
      .map(({ date, value }) => SolarForecaster.withProfile({
        date,
        actualWh: value,
        ...days[date],
        ...(power ? { actualHours: power[date]?.hours } : {}),
      }, profile));
  }

  // Learns the shading and seasonal profiles from the year up to endDate
  // (default: yesterday). Either is null when there isn't enough history for
  // it, so the caller can store that and not retry daily.
  // shadingOptions is passed to buildShadingProfile, for tuning.
  async buildProfile({ now = new Date(), endDate, shadingOptions = {} } = {}) {
    await this.init();

    const today = localDate(now, this.timeZone);
    const end = endDate ?? addDays(today, -1);
    const start = addDays(end, -(SolarForecaster.HISTORY_DAYS - 1));

    const capW = (await this.getCapW({ endDate: end })) ?? Infinity;
    const days = await this.loadDays({
      startDate: start, endDate: end, weather: 'archive', withHours: true,
    });
    const seasonal = buildSeasonalProfile(days, { capW });
    const shading = buildShadingProfile(days, { capW, peakPowerW: this.peakPowerW, ...shadingOptions });

    return {
      version: SolarForecaster.PROFILE_VERSION,
      multipliers: seasonal?.multipliers ?? null,
      shading,
      days: seasonal?.days ?? days.length,
      date: today,
      configKey: this.configKey,
    };
  }

  // Fits the factor over the CALIBRATION_DAYS up to and including yesterday,
  // and the forecast range over the whole year. Today is excluded: its
  // production so far is only part of a day.
  async calibrate({ now = new Date(), profile = null } = {}) {
    await this.init();

    const today = localDate(now, this.timeZone);
    const endDate = addDays(today, -1);
    const startDate = addDays(endDate, -(SolarForecaster.HISTORY_DAYS - 1));
    const factorStart = addDays(endDate, -(SolarForecaster.CALIBRATION_DAYS - 1));

    const capW = await this.getCapW({ endDate });
    const days = await this.loadDays({
      startDate, endDate, weather: 'dayAhead', profile,
    });

    const fit = fitFactor(days.filter((day) => day.date >= factorStart), {
      capW: capW ?? Infinity,
      asOfDate: endDate,
    });
    const bands = fitBands(days, { factor: fit.factor, capW: capW ?? Infinity });
    const ceilingWh = fitCeiling(days.filter((day) => day.date > addDays(endDate, -CEILING_DAYS)));

    return {
      ...fit,
      bands,
      ceilingWh,
      peakPowerW: this.peakPowerW,
      capW,
      date: today,
      configKey: this.configKey,
      profileDate: profile?.date ?? null,
    };
  }

  // Today and tomorrow:
  //   hours: [{ time, wh }], wh being the energy expected in the hour
  //          *ending* at time
  //   days:  { 'YYYY-MM-DD': { p10, p50, p90, cloudCover } } in Wh
  // Hours are scaled so each day's add up to its P50.
  async forecast({ calibration, profile = null }) {
    await this.init();

    const hours = await this.getHours('getForecast', { forecastDays: 2 });
    const capW = calibration.capW ?? Infinity;

    // Each day's total comes from the seasonal model. Its hours are shaped by
    // the shading profile when there is one, and scaled to add up to P50.
    const days = {};
    const hourWh = {};
    for (const [date, summary] of Object.entries(summariseDays(hours, calibration.peakPowerW))) {
      const day = SolarForecaster.withProfile({ date, ...summary }, profile);
      const modelWh = predictDay(day, calibration.factor, capW);
      days[date] = {
        ...applyBands(modelWh, day.cloudCover, calibration.bands, { ceilingWh: calibration.ceilingWh }),
        modelWh,
        cloudCover: day.cloudCover,
      };

      const shape = profile?.shading ? shadingMultipliers(profile.shading, day) : day.idealHours.map(() => day.multiplier);
      const shaped = day.idealHours.map((idealWh, i) => predictHourWh(idealWh, calibration.factor * shape[i], capW));
      const total = shaped.reduce((sum, wh) => sum + wh, 0);
      day.hourOfDay.forEach((hour, i) => {
        hourWh[`${date}T${String(hour).padStart(2, '0')}`] = total > 0 ? shaped[i] * (days[date].p50 / total) : 0;
      });
    }

    return {
      days,
      hours: hours.map((hour) => ({ time: hour.time, wh: hourWh[hour.time.slice(0, 13)] ?? 0 })),
    };
  }

  static summarise(forecast, { now = new Date(), timeZone }) {
    const today = localDate(now, timeZone);
    const tomorrow = addDays(today, 1);
    const empty = { p10: 0, p50: 0, p90: 0 };

    return {
      today: forecast.days[today] ?? empty,
      tomorrow: forecast.days[tomorrow] ?? empty,
      powerNowW: SolarForecaster.expectedPowerAt(forecast, { at: now, timeZone }),
    };
  }

  // Expected mean power (W) over the hour containing the given moment. An
  // hour's energy in Wh is its mean power in W.
  static expectedPowerAt(forecast, { at, timeZone }) {
    const atString = localDateTime(at, timeZone);
    return forecast.hours.find((hour) => hour.time > atString)?.wh ?? 0;
  }

  // The next time the local clock reads 'HH:MM': today if that's still ahead,
  // otherwise tomorrow. Returned as a Date, for expectedPowerAt().
  static nextOccurrence(clock, { now = new Date(), timeZone }) {
    const nowString = localDateTime(now, timeZone);
    const today = nowString.slice(0, 10);
    const target = `${today}T${clock}`;
    const minutesAhead = (Date.parse(`${target}:00Z`) - Date.parse(`${nowString}:00Z`)) / 60000;

    return new Date(now.getTime() + (minutesAhead >= 0 ? minutesAhead : minutesAhead + 1440) * 60000);
  }

}

module.exports = SolarForecaster;
