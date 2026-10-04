// Pure forecast maths: no I/O, no Homey, so it can be tested and backtested
// in plain Node.
//
// The model is "ideal output × seasonal multiplier × fitted factor":
//
// - Ideal output is what the array's nameplate rating would produce from the
//   forecast irradiance on its plane, corrected for cell temperature.
// - The seasonal multiplier, learned from a year of this site's daily
//   production, captures what changes through the year: mostly shading from
//   a low winter sun.
// - The factor, fitted against the last couple of months, absorbs the rest:
//   inverter and wiring losses, soiling, ageing, wrong tilt/orientation
//   settings, and any systematic bias in the weather forecast itself.
//
// Around that, a P10–P90 range comes from how far past forecasts missed,
// grouped by how cloudy they said it would be.
//
// A shading profile, learned from a year of hourly production, then spreads
// each day's total over its hours: trees, roofs and the horizon cut the sun
// at particular times of day, differently through the year, and it also
// absorbs a panel direction that's set wrong. It only shapes the day. Used
// for the totals too, it did worse than the seasonal multiplier (backtest,
// 2026-10-04: 20.4–21.6% daily error against 19.5%), while as a shape it cut
// the hourly error against P50 from 44.6% to 32.5%.

import {
  addDays, daysBetween, localDate, localDateTime,
} from './LocalDate.mjs';

export const DEFAULT_FACTOR = 0.8;

// Fewer usable days than this and the fit is too noisy to trust.
export const MIN_CALIBRATION_DAYS = 7;

// Silicon loses about 0.37% of output per °C above 25 °C.
const TEMPERATURE_COEFFICIENT = -0.0037;

// Cell temperature rises roughly 0.03 °C above ambient per W/m² (NOCT 45 °C).
const CELL_HEATING_PER_WM2 = 0.03;

const RECENCY_HALF_LIFE_DAYS = 21;

// The seasonal multiplier for a day is learned from days within this many
// days of the same date in other years (or earlier this year).
const SEASON_WINDOW_DAYS = 30;

// Less history than this and there is no seasonal profile at all.
export const MIN_PROFILE_DAYS = 60;

// A day producing under this fraction of its expected output was an outage
// or missing data, not weather, so it says nothing about the season.
const OUTAGE_RATIO = 0.2;

// Daytime cloud cover (%) boundaries for the forecast-range groups:
// clear-ish, mixed, overcast.
const CLOUD_BIN_EDGES = [35, 70];

// Fewer past days than this in a cloud group and the range falls back to
// all days pooled.
const MIN_BAND_DAYS = 15;

// No forecast goes above the best day of the last CEILING_DAYS by more than
// CEILING_HEADROOM. Without this, the wide range of a mixed-cloud day can
// put P90 well past what the array has ever produced.
export const CEILING_DAYS = 30;
const CEILING_HEADROOM = 1.2;

// Whether P50 is shifted by its cloud group's median miss. The backtest
// compares both, so this stays switchable.
const CORRECT_CLOUD_LEAN = true;

const FACTOR_MIN = 0.2;
const FACTOR_MAX = 1.5;
const FACTOR_STEP = 0.002;

// ---- Dates ------------------------------------------------------------------
// Everything is keyed by local 'YYYY-MM-DD' strings in the site's time zone
// (see LocalDate.mjs, re-exported here for the forecast's callers).

export {
  addDays, daysBetween, localDate, localDateTime,
};

// Covers an inclusive date range with [{ startDate, endDate }] blocks small
// enough for one SolarEdge request: calendar months (unit 'month'), or runs
// of `unit` days counted from 1970-01-01. Blocks start on those fixed
// boundaries, so the first may begin before startDate (callers filter), and
// only the last is cut short at endDate. As the range slides forward a day at
// a time, every complete block stays identical and can be cached.
export function alignedBlocks(startDate, endDate, unit) {
  const blocks = [];

  let start;
  if (unit === 'month') {
    start = `${startDate.slice(0, 7)}-01`;
  } else {
    const offset = daysBetween('1970-01-01', startDate);
    start = addDays(startDate, -(((offset % unit) + unit) % unit));
  }

  while (start <= endDate) {
    let blockEnd;
    if (unit === 'month') {
      const [year, month] = start.split('-').map(Number);
      blockEnd = addDays(`${year + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}-01`, -1);
    } else {
      blockEnd = addDays(start, unit - 1);
    }

    blocks.push({ startDate: start, endDate: blockEnd < endDate ? blockEnd : endDate });
    start = addDays(blockEnd, 1);
  }

  return blocks;
}

// ---- Model ------------------------------------------------------------------

// Energy (Wh) the array would produce over one hour of the given mean
// irradiance (W/m²) on its plane, before any losses.
export function idealHourlyWh({ gti, temperature }, peakPowerW) {
  if (typeof gti !== 'number' || gti <= 0) return 0;

  const cellTemperature = (temperature ?? 25) + gti * CELL_HEATING_PER_WM2;
  const derate = 1 + TEMPERATURE_COEFFICIENT * (cellTemperature - 25);

  return peakPowerW * (gti / 1000) * derate;
}

// A single hour's prediction. capW is the most the inverter has been seen to
// deliver: an oversized array clips there no matter how sunny it is.
export function predictHourWh(idealWh, factor, capW = Infinity) {
  return Math.min(idealWh * factor, capW);
}

// hourMultipliers, when given, scales each hour (the shading profile).
export function predictDayWh(idealHours, factor, capW, hourMultipliers = null) {
  return idealHours.reduce((sum, idealWh, i) => sum + predictHourWh(idealWh, factor * (hourMultipliers?.[i] ?? 1), capW), 0);
}

// A day is { date, actualWh, idealHours, multiplier?, hourMultipliers?,
// cloudCover? }: multiplier is the seasonal multiplier for its date,
// hourMultipliers the shading profile's for each of its hours. A day carries
// one or the other.
export function predictDay(day, factor, capW) {
  return predictDayWh(day.idealHours, factor * (day.multiplier ?? 1), capW, day.hourMultipliers);
}

// Groups Open-Meteo hours ([{ time, gti, temperature, cloudCover }]) into
// { 'YYYY-MM-DD': { idealHours, hourOfDay, cloudHours, cloudCover } }:
// idealWh, the hour (0–23, the hour *ending* at that time, as Open-Meteo
// labels its averages) and cloud cover for each hour, and the day's cloud
// cover weighted by sunshine: cloud at night is irrelevant, cloud at noon
// matters most.
export function summariseDays(hours, peakPowerW) {
  const byDate = {};

  for (const hour of hours) {
    const date = hour.time.slice(0, 10);
    byDate[date] ??= {
      idealHours: [], hourOfDay: [], cloudHours: [], cloudWeighted: 0, weight: 0,
    };
    const day = byDate[date];
    const idealWh = idealHourlyWh(hour, peakPowerW);

    day.idealHours.push(idealWh);
    day.hourOfDay.push(Number(hour.time.slice(11, 13)));
    day.cloudHours.push(typeof hour.cloudCover === 'number' ? hour.cloudCover : null);
    if (typeof hour.cloudCover === 'number') {
      day.cloudWeighted += hour.cloudCover * idealWh;
      day.weight += idealWh;
    }
  }

  return Object.fromEntries(Object.entries(byDate).map(([date, day]) => [date, {
    idealHours: day.idealHours,
    hourOfDay: day.hourOfDay,
    cloudHours: day.cloudHours,
    cloudCover: day.weight > 0 ? day.cloudWeighted / day.weight : null,
  }]));
}

function recencyWeight(ageDays, halfLife) {
  return 0.5 ** (ageDays / halfLife);
}

function weightedMedian(items) {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);

  let running = 0;
  for (const item of sorted) {
    running += item.weight;
    if (running >= total / 2) return item.value;
  }
  return sorted[sorted.length - 1]?.value;
}

function quantile(sortedValues, q) {
  const position = (sortedValues.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

function isUsable(day) {
  return day.actualWh > 0 && day.idealHours.reduce((a, b) => a + b, 0) > 0;
}

// Fits the factor to days of [{ date, actualWh, idealHours, multiplier? }].
//
// Minimises the recency-weighted sum of |log(predicted / actual)|: a weighted
// median, so a handful of outage, snow or badly mis-forecast days barely move
// it. Days with no production (an outage, or missing data) are dropped
// outright, since they say nothing about the array.
export function fitFactor(days, { capW = Infinity, asOfDate, halfLife = RECENCY_HALF_LIFE_DAYS } = {}) {
  const usable = days.filter(isUsable);

  if (usable.length < MIN_CALIBRATION_DAYS) {
    return { factor: DEFAULT_FACTOR, days: usable.length, calibrated: false };
  }

  const lastDate = asOfDate ?? usable[usable.length - 1].date;
  const weighted = usable.map((day) => ({
    ...day,
    weight: recencyWeight(daysBetween(day.date, lastDate), halfLife),
  }));

  let best = { factor: DEFAULT_FACTOR, loss: Infinity };

  for (let factor = FACTOR_MIN; factor <= FACTOR_MAX; factor += FACTOR_STEP) {
    let loss = 0;
    for (const day of weighted) {
      loss += day.weight * Math.abs(Math.log(predictDay(day, factor, capW) / day.actualWh));
    }
    if (loss < best.loss) best = { factor, loss };
  }

  return {
    factor: Math.round(best.factor * 1000) / 1000,
    days: usable.length,
    calibrated: true,
  };
}

// ---- Seasonal profile -------------------------------------------------------

export function dayOfYear(dateString) {
  return daysBetween(`${dateString.slice(0, 4)}-01-01`, dateString) + 1;
}

function seasonalDistance(dayA, dayB) {
  const distance = Math.abs(dayA - dayB);
  return Math.min(distance, 365 - distance);
}

// Learns a multiplier for every day of the year from a year or more of days
// ([{ date, actualWh, idealHours }], weather from archived forecasts).
//
// Each day's ratio of actual to expected output is taken against a single
// year-round factor; a date's multiplier is then the weighted median of those
// ratios within SEASON_WINDOW_DAYS of it, nearer days counting more. Sparse
// windows are pulled towards 1, so a gap in the history leaves the forecast
// alone instead of guessing.
export function buildSeasonalProfile(days, { capW = Infinity } = {}) {
  const usable = days.filter(isUsable);
  if (usable.length < MIN_PROFILE_DAYS) return null;

  const { factor } = fitFactor(usable, { capW, halfLife: Infinity });

  const ratios = usable
    .map((day) => ({
      dayOfYear: dayOfYear(day.date),
      logRatio: Math.log(day.actualWh / predictDayWh(day.idealHours, factor, capW)),
    }))
    .filter((r) => r.logRatio > Math.log(OUTAGE_RATIO));

  const multipliers = [];
  for (let day = 1; day <= 366; day++) {
    const nearby = ratios
      .map((r) => ({ value: r.logRatio, distance: seasonalDistance(day, r.dayOfYear) }))
      .filter((r) => r.distance <= SEASON_WINDOW_DAYS)
      .map((r) => ({ value: r.value, weight: 1 - r.distance / (SEASON_WINDOW_DAYS + 1) }));

    // A window is trusted fully from about 10 days' worth of evidence, and
    // proportionally less below that.
    const evidence = nearby.reduce((sum, r) => sum + r.weight, 0);
    const shrink = Math.min(1, evidence / 10);
    const logMultiplier = nearby.length ? weightedMedian(nearby) * shrink : 0;

    multipliers.push(Math.round(Math.exp(logMultiplier) * 1000) / 1000);
  }

  return { multipliers, days: usable.length };
}

export function seasonalMultiplier(profile, dateString) {
  return profile?.multipliers?.[dayOfYear(dateString) - 1] ?? 1;
}

// ---- Shading profile --------------------------------------------------------

// Less hourly history than this and there is no shading profile; the
// seasonal one is used instead.
export const MIN_SHADING_DAYS = 60;

// Hours whose ideal output is under this fraction of peak power are dawn and
// dusk: small numbers whose ratios are mostly noise.
const MIN_SHADING_IDEAL_FRACTION = 0.05;

// Only hours the archived forecast called this clear or clearer teach the
// profile. Shading blocks direct sun, so leaving out cloudy hours seemed
// right, but the backtest liked the shape learned from every hour best (more
// evidence beats purer evidence in a cloudy climate), so this lets all in.
const SHADING_MAX_CLOUD = 100;

// Hours at or near the clipping cap say nothing about shading.
const CLIP_MARGIN = 0.95;

// An hour that delivered under this fraction of its ideal is floored here
// before taking logs, so a fully shaded hour counts as heavily shaded rather
// than breaking the median.
const MIN_HOUR_RATIO = 0.02;

// A month × hour cell is trusted fully from this many clear hours' worth of
// evidence, and proportionally less below that.
const SHADING_FULL_EVIDENCE = 8;

// Neighbouring hours each side whose evidence a cell borrows, at half weight.
// Smooths out a cell built from a handful of odd hours.
const SHADING_HOUR_SPREAD = 1;

// Day of the year of the 15th of each month, where each month's cell sits.
const MONTH_CENTRES = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

// Learns a multiplier for each hour (0–23, the hour ending then) of each
// month from a year or more of days with hourly production:
// [{ date, actualWh, actualHours: [Wh by hour], idealHours, hourOfDay,
// cloudHours }], weather from archived forecasts.
//
// Every clear, unclipped daylight hour gives a ratio of actual to ideal
// output, against one year-round factor. A cell's multiplier is the weighted
// median of those ratios at its hour within SEASON_WINDOW_DAYS of its month's
// centre, nearer days counting more, divided by the median over all of them
// so a typical unshaded hour is 1. Sparse cells are pulled towards 1.
//
// maxCloud, fullEvidence and hourSpread (how many neighbouring hours each
// side lend their evidence, at half weight) default to the constants above;
// the harness varies them to tune.
export function buildShadingProfile(days, {
  capW = Infinity,
  peakPowerW,
  maxCloud = SHADING_MAX_CLOUD,
  fullEvidence = SHADING_FULL_EVIDENCE,
  hourSpread = SHADING_HOUR_SPREAD,
} = {}) {
  const usable = days.filter((day) => isUsable(day) && Array.isArray(day.actualHours));
  if (usable.length < MIN_SHADING_DAYS) return null;

  const { factor } = fitFactor(usable, { capW, halfLife: Infinity });
  const minIdealWh = peakPowerW * MIN_SHADING_IDEAL_FRACTION;

  const samples = [];
  for (const day of usable) {
    // Outage or missing-data days say nothing about shading.
    if (day.actualWh < OUTAGE_RATIO * predictDayWh(day.idealHours, factor, capW)) continue;

    const doy = dayOfYear(day.date);
    day.idealHours.forEach((idealWh, i) => {
      const hour = day.hourOfDay[i];
      const actualWh = day.actualHours[hour];
      const cloud = day.cloudHours[i];

      if (idealWh < minIdealWh || typeof actualWh !== 'number') return;
      if (typeof cloud !== 'number' || cloud > maxCloud) return;
      if (actualWh >= CLIP_MARGIN * capW) return;

      const ratio = Math.max(actualWh / (idealWh * factor), MIN_HOUR_RATIO);
      samples.push({ doy, hour, value: Math.log(ratio) });
    });
  }

  if (!samples.length) return null;

  const centre = weightedMedian(samples.map((s) => ({ value: s.value, weight: 1 })));

  const cells = MONTH_CENTRES.map((monthDoy) => {
    const row = [];
    for (let hour = 0; hour < 24; hour++) {
      const nearby = samples
        .filter((s) => Math.abs(s.hour - hour) <= hourSpread)
        .map((s) => ({
          value: s.value - centre,
          distance: seasonalDistance(monthDoy, s.doy),
          hourWeight: s.hour === hour ? 1 : 0.5,
        }))
        .filter((s) => s.distance <= SEASON_WINDOW_DAYS)
        .map((s) => ({ value: s.value, weight: s.hourWeight * (1 - s.distance / (SEASON_WINDOW_DAYS + 1)) }));

      const evidence = nearby.reduce((sum, s) => sum + s.weight, 0);
      const shrink = Math.min(1, evidence / fullEvidence);
      const logMultiplier = nearby.length ? weightedMedian(nearby) * shrink : 0;

      row.push(Math.round(Math.exp(logMultiplier) * 1000) / 1000);
    }
    return row;
  });

  return { cells, days: usable.length, hours: samples.length };
}

// The profile's multiplier for each of a day's hours, interpolated between
// the cells of the months either side of its date. Applied in full whatever
// the cloud: easing it off for cloudy hours did worse in the backtest.
export function shadingMultipliers(profile, day) {
  const { cells } = profile;
  const doy = dayOfYear(day.date);

  // The month centres either side of the date, wrapping round the year.
  let after = MONTH_CENTRES.findIndex((centreDoy) => centreDoy >= doy);
  if (after === -1) after = 0;
  const before = (after + 11) % 12;
  const span = (MONTH_CENTRES[after] - MONTH_CENTRES[before] + 365) % 365;
  const into = (doy - MONTH_CENTRES[before] + 365) % 365;
  const t = span > 0 ? into / span : 0;

  return day.hourOfDay.map((hour) => cells[before][hour] * (1 - t) + cells[after][hour] * t);
}

// ---- Forecast range ---------------------------------------------------------

export function cloudBin(cloudCover) {
  if (typeof cloudCover !== 'number') return null;
  return CLOUD_BIN_EDGES.filter((edge) => cloudCover >= edge).length;
}

function residualQuantiles(logResiduals) {
  const sorted = [...logResiduals].sort((a, b) => a - b);
  return {
    days: sorted.length,
    q10: quantile(sorted, 0.1),
    q50: quantile(sorted, 0.5),
    q90: quantile(sorted, 0.9),
  };
}

// How far past day-ahead forecasts missed, as log(actual / predicted)
// quantiles for each cloud group. Overcast forecasts miss far more, and
// lopsidedly, than clear ones.
//
// The quantiles are taken relative to the median miss over all groups. The
// factor already centres the forecast on recent days, so only how each kind
// of weather leans relative to the rest is left to correct, not a year-old
// overall offset the factor has since moved past.
export function fitBands(days, { factor, capW = Infinity }) {
  const residuals = days
    .filter((day) => isUsable(day) && cloudBin(day.cloudCover) !== null)
    .map((day) => ({
      bin: cloudBin(day.cloudCover),
      value: Math.log(day.actualWh / predictDay(day, factor, capW)),
    }));

  if (residuals.length < MIN_BAND_DAYS) return null;

  const centre = residualQuantiles(residuals.map((r) => r.value)).q50;
  const centred = residuals.map((r) => ({ ...r, value: r.value - centre }));

  const pooled = residualQuantiles(centred.map((r) => r.value));
  const bins = [0, 1, 2].map((bin) => {
    const values = centred.filter((r) => r.bin === bin).map((r) => r.value);
    return values.length >= MIN_BAND_DAYS ? residualQuantiles(values) : pooled;
  });

  return { bins, days: residuals.length };
}

// The most any forecast may say, from the best of the given recent days.
export function fitCeiling(recentDays) {
  const best = Math.max(0, ...recentDays.filter(isUsable).map((day) => day.actualWh));
  return best > 0 ? best * CEILING_HEADROOM : null;
}

// Turns a model prediction into { p10, p50, p90 }, capped at ceilingWh. P50
// is shifted by the cloud group's lean: overcast forecasts, for one, tend to
// come in under.
export function applyBands(wh, cloudCover, bands, { ceilingWh = Infinity, correctCloud = CORRECT_CLOUD_LEAN } = {}) {
  const bin = bands?.bins?.[cloudBin(cloudCover)];
  const cap = (value) => Math.min(value, ceilingWh ?? Infinity);

  if (!bin) return { p10: cap(wh), p50: cap(wh), p90: cap(wh) };

  return {
    p10: cap(wh * Math.exp(bin.q10)),
    p50: cap(correctCloud ? wh * Math.exp(bin.q50) : wh),
    p90: cap(wh * Math.exp(bin.q90)),
  };
}
