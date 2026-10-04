import OpenMeteoAPI from './OpenMeteoAPI.mjs';
import {
  CEILING_DAYS,
  addDays,
  alignedBlocks,
  applyBands,
  buildSeasonalProfile,
  fitBands,
  fitCeiling,
  fitFactor,
  idealHourlyWh,
  localDate,
  localDateTime,
  predictDay,
  predictHourWh,
  seasonalMultiplier,
  summariseDays,
} from './SolarForecastModel.mjs';

// Fetches what the model needs and runs it. Deliberately free of Homey so the
// same code runs in the app and in scripts/forecast-poc.mjs.
//
// SolarEdge data comes from the monitoring dashboard endpoints the app logs in
// to, which have no published quota but shouldn't be hammered. History is
// fetched in fixed blocks (calendar months of daily energy, weeks of 15-minute
// power) and complete blocks are kept, so after the first run (about 13 energy
// and 4 power requests) a day costs about 2. forecast() makes none.
export default class SolarForecaster {

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

  // latitude and longitude are optional: SolarEdge knows where most sites
  // are, and its coordinates are used when these are left out.
  constructor({
    solarEdgeApi,
    openMeteoApi = new OpenMeteoAPI(),
    siteId,
    timeZone,
    latitude,
    longitude,
    tilt,
    azimuth,
  }) {
    this.solarEdgeApi = solarEdgeApi;
    this.openMeteoApi = openMeteoApi;
    this.siteId = siteId;
    this.timeZone = timeZone;
    this.requested = {
      latitude, longitude, tilt, azimuth,
    };

    this.location = null;
    this.peakPowerW = null;
    this.capCache = null;
    this.blockCaches = { energy: new Map(), power: new Map() };
  }

  async init() {
    if (this.location) return;

    const details = await this.solarEdgeApi.getSiteDetails({ siteId: this.siteId });

    this.peakPowerW = details?.peakPower > 0 ? details.peakPower * 1000 : null;
    if (!this.peakPowerW) {
      throw new Error('SolarEdge did not report the site\'s peak power');
    }

    const latitude = this.requested.latitude ?? Number(details.latitude);
    const longitude = this.requested.longitude ?? Number(details.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('SolarEdge did not report the site\'s location');
    }

    this.location = {
      latitude,
      longitude,
      tilt: this.requested.tilt,
      // Panels face the equator unless told otherwise.
      azimuth: this.requested.azimuth ?? (latitude < 0 ? 0 : 180),
      timeZone: this.timeZone,
    };
  }

  // Changes to any of these invalidate a profile or calibration, since both
  // were fitted against irradiance computed from them.
  get configKey() {
    const {
      latitude, longitude, tilt, azimuth,
    } = this.location;
    return [latitude.toFixed(3), longitude.toFixed(3), tilt, azimuth].join('|');
  }

  // [{ date: 'YYYY-MM-DD', time, value }] over the range, gathered block by
  // block. Every block requested is kept for next time and the rest dropped:
  // the range only ever slides forward, and ends no later than yesterday, so
  // a block's data doesn't change once fetched. fetchBlock returns
  // [{ measurementTime, value }].
  //
  // The cache holds promises, so a caller arriving while a block is in flight
  // waits for it rather than fetching it again. That happens when a failed
  // Open-Meteo request rejects loadDays()'s Promise.all and the next step
  // asks for the same year while this is still running. Failed blocks are
  // dropped so they're retried.
  async getBlocks(kind, { startDate, endDate, unit }, fetchBlock) {
    const cache = this.blockCaches[kind];
    const used = new Set();
    const values = [];

    for (const block of alignedBlocks(startDate, endDate, unit)) {
      const key = `${block.startDate}|${block.endDate}`;
      used.add(key);

      let pending = cache.get(key);
      if (!pending) {
        pending = fetchBlock(block);
        cache.set(key, pending);
        pending.catch(() => {
          if (cache.get(key) === pending) cache.delete(key);
        });
      }

      // One block at a time, to go easy on SolarEdge.
      values.push(...await pending);
    }

    for (const key of cache.keys()) {
      if (!used.has(key)) cache.delete(key);
    }

    return values
      .map(({ measurementTime, value }) => ({ date: measurementTime.slice(0, 10), time: measurementTime, value }))
      .filter(({ date }) => date >= startDate && date <= endDate);
  }

  // The inverter's clipping limit, from the highest power in the four weeks
  // up to endDate. Remembered per endDate, since the profile and calibration
  // both want it on the same day.
  async getCapW({ endDate }) {
    if (this.capCache?.endDate !== endDate) {
      const startDate = addDays(endDate, -(SolarForecaster.MAX_POWER_DAYS - 1));
      const samples = await this.getBlocks('power', { startDate, endDate, unit: SolarForecaster.POWER_BLOCK_DAYS }, async (block) => {
        const { measurements } = await this.solarEdgeApi.getSitePower({ siteId: this.siteId, ...block });
        return (measurements ?? []).map((m) => ({ measurementTime: m.measurementTime, value: m.production }));
      });

      const values = samples.map((v) => v.value).filter((v) => typeof v === 'number');
      const capW = values.length ? Math.max(...values) * SolarForecaster.CAP_HEADROOM : null;
      this.capCache = { endDate, capW };
    }

    return this.capCache.capW;
  }

  // Daily PV production as [{ date, value }] in Wh.
  async getEnergy({ startDate, endDate }) {
    return this.getBlocks('energy', { startDate, endDate, unit: SolarForecaster.ENERGY_BLOCK }, async (block) => {
      const { chart } = await this.solarEdgeApi.getSiteEnergy({ siteId: this.siteId, ...block });
      return (chart?.measurements ?? []).map((m) => ({ measurementTime: m.measurementTime, value: m.production }));
    });
  }

  // [{ date, actualWh, idealHours, cloudCover, multiplier }] for every day in
  // the range that has both a SolarEdge reading and weather. weather is
  // 'dayAhead' (what was forecast the day before) or 'archive' (close to what
  // actually happened).
  async loadDays({
    startDate, endDate, weather, profile,
  }) {
    await this.init();

    const getHours = weather === 'archive'
      ? this.openMeteoApi.getHistoricalForecast.bind(this.openMeteoApi)
      : this.openMeteoApi.getDayAheadHistory.bind(this.openMeteoApi);

    const [energy, hours] = await Promise.all([
      this.getEnergy({ startDate, endDate }),
      getHours({ ...this.location, startDate, endDate }),
    ]);

    const days = summariseDays(hours, this.peakPowerW);

    return energy
      .map(({ date, value }) => ({
        date,
        actualWh: value,
        ...days[date],
        multiplier: seasonalMultiplier(profile, date),
      }))
      .filter((day) => typeof day.actualWh === 'number' && day.idealHours);
  }

  // Learns the seasonal profile from the year up to endDate (default:
  // yesterday). Returns a profile with multipliers: null when there isn't
  // enough history, so the caller can store that and not retry daily.
  async buildProfile({ now = new Date(), endDate } = {}) {
    await this.init();

    const today = localDate(now, this.timeZone);
    const end = endDate ?? addDays(today, -1);
    const start = addDays(end, -(SolarForecaster.HISTORY_DAYS - 1));

    const capW = await this.getCapW({ endDate: end });
    const days = await this.loadDays({ startDate: start, endDate: end, weather: 'archive' });
    const profile = buildSeasonalProfile(days, { capW: capW ?? Infinity });

    return {
      multipliers: profile?.multipliers ?? null,
      days: profile?.days ?? days.length,
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

    const hours = await this.openMeteoApi.getForecast({ ...this.location, forecastDays: 2 });
    const capW = calibration.capW ?? Infinity;

    const days = {};
    for (const [date, day] of Object.entries(summariseDays(hours, calibration.peakPowerW))) {
      const modelWh = predictDay({ ...day, multiplier: seasonalMultiplier(profile, date) }, calibration.factor, capW);
      days[date] = {
        ...applyBands(modelWh, day.cloudCover, calibration.bands, { ceilingWh: calibration.ceilingWh }),
        modelWh,
        cloudCover: day.cloudCover,
      };
    }

    return {
      days,
      hours: hours.map((hour) => {
        const date = hour.time.slice(0, 10);
        const { modelWh, p50 } = days[date];
        const wh = predictHourWh(
          idealHourlyWh(hour, calibration.peakPowerW),
          calibration.factor * seasonalMultiplier(profile, date),
          capW,
        );
        return { time: hour.time, wh: modelWh > 0 ? wh * (p50 / modelWh) : 0 };
      }),
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
