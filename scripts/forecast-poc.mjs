/* eslint-disable no-console */
// Local harness for the solar forecast: runs the same SolarForecaster the app
// uses against the real SolarEdge and Open-Meteo APIs, without a Homey.
//
//   npm run forecast                 calibrate, then forecast today + tomorrow
//   npm run forecast -- backtest     replay the last 90 days as day-ahead forecasts,
//                                    phase 1 against phase 2
//
// Options: --days N (backtest length), --tilt DEG, --azimuth DEG (compass,
// 0 = N, 90 = E, 180 = S, 270 = W), --verbose, --no-cache.
//
// Configuration comes from .env (gitignored):
//   SOLAREDGE_USERNAME / SOLAREDGE_PASSWORD   required, your monitoring.solaredge.com login
//   SOLAREDGE_SITE_ID=...            optional, defaults to the account's first site
//   SITE_LATITUDE / SITE_LONGITUDE   optional, else the site's coordinates in SolarEdge
//   PANEL_TILT / PANEL_AZIMUTH       optional, default 20° facing the equator
//
// API responses are cached in .cache/forecast-poc for 6 hours, to go easy on
// SolarEdge and Open-Meteo while iterating.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import OpenMeteoAPI from '../lib/OpenMeteoAPI.mjs';
import SolarEdgeAPI from '../lib/SolarEdgeAPI.mjs';
import SolarForecaster from '../lib/SolarForecaster.mjs';
import {
  DEFAULT_FACTOR,
  addDays,
  CEILING_DAYS,
  applyBands,
  fitBands,
  fitCeiling,
  fitFactor,
  localDate,
  predictDay,
  predictHourWh,
  seasonalMultiplier,
  shadingMultipliers,
} from '../lib/SolarForecastModel.mjs';

const CACHE_DIR = path.resolve(import.meta.dirname, '../.cache/forecast-poc');
const CACHE_TTL = 1000 * 60 * 60 * 6;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: 'string', default: '90' },
    tilt: { type: 'string' },
    azimuth: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    brief: { type: 'boolean', default: false },
    'no-cache': { type: 'boolean', default: false },
    // Shading profile tuning, see buildShadingProfile.
    'shading-cloud': { type: 'string' },
    'shading-evidence': { type: 'string' },
    'shading-spread': { type: 'string' },
  },
});

const command = positionals[0] ?? 'forecast';

// Wraps an API client so every async method call is served from disk when a
// fresh enough copy exists. The key is a hash of the call, so nothing from
// the call ends up in a filename.
function cached(target, prefix) {
  return new Proxy(target, {
    get(obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function' || ['request', 'buildUrl', 'login', 'isLoggedIn'].includes(prop)) {
        return value;
      }

      return async (...args) => {
        // HOURLY is part of the key so adding a weather variable refetches.
        const key = `${prefix}.${String(prop)}:${JSON.stringify(args)}:${JSON.stringify(obj.constructor.HOURLY ?? null)}`;
        const hash = crypto.createHash('sha1').update(key).digest('hex');
        const file = path.join(CACHE_DIR, `${prefix}-${String(prop)}-${hash.slice(0, 12)}.json`);

        if (!opts['no-cache']) {
          try {
            const stat = await fs.stat(file);
            if (Date.now() - stat.mtimeMs < CACHE_TTL) {
              return JSON.parse(await fs.readFile(file, 'utf8'));
            }
          } catch {
            // Not cached yet.
          }
        }

        const result = await value.apply(obj, args);
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(file, JSON.stringify(result));
        return result;
      };
    },
  });
}

// Keeps the forecaster's history in .cache, as the device store does on a
// Homey, so a rerun only fetches days it hasn't seen.
function fileHistoryStore(siteId) {
  const file = path.join(CACHE_DIR, `history-${siteId}.json`);
  return {
    async load() {
      try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        return null;
      }
    },
    async save(history) {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(file, JSON.stringify(history));
    },
  };
}

class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message);
}

const kwh = (wh) => (wh / 1000).toFixed(1);
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

async function setup() {
  const { SOLAREDGE_USERNAME: username, SOLAREDGE_PASSWORD: password } = process.env;
  if (!username || !password) {
    fail('Set SOLAREDGE_USERNAME and SOLAREDGE_PASSWORD in .env (see the header of scripts/forecast-poc.mjs).');
  }

  // Logging in costs one request even when every call below is cached, which
  // keeps the cache simple.
  const rawSolarEdge = new SolarEdgeAPI();
  await rawSolarEdge.login({ username, password });
  const solarEdgeApi = cached(rawSolarEdge, 'solaredge');
  const openMeteoApi = cached(new OpenMeteoAPI(), 'openmeteo');

  let siteId = process.env.SOLAREDGE_SITE_ID;
  if (!siteId) {
    const list = Object.values(await solarEdgeApi.getSites());
    if (!list.length) fail('No sites found for this login.');
    siteId = String(list[0].id);
    if (list.length > 1) {
      console.log(`Login has ${list.length} sites, using ${siteId} (${list[0].name}). Set SOLAREDGE_SITE_ID to choose.`);
    }
  }

  const details = await solarEdgeApi.getSiteDetails({ siteId });
  const timeZone = await solarEdgeApi.getSiteTimeZone({ siteId });
  if (!timeZone) fail('SolarEdge did not report the site\'s time zone.');

  const envNumber = (name) => (process.env[name] ? Number(process.env[name]) : undefined);
  const optNumber = (value) => (value !== undefined ? Number(value) : undefined);

  const latitude = envNumber('SITE_LATITUDE');
  const longitude = envNumber('SITE_LONGITUDE');
  const tilt = optNumber(opts.tilt) ?? envNumber('PANEL_TILT') ?? 20;
  const azimuth = optNumber(opts.azimuth) ?? envNumber('PANEL_AZIMUTH');

  const forecaster = new SolarForecaster({
    solarEdgeApi,
    openMeteoApi,
    siteId,
    timeZone,
    latitude,
    longitude,
    tilt,
    azimuth,
    historyStore: opts['no-cache'] ? null : fileHistoryStore(siteId),
    // The backtest learns its profile from the year before the test period.
    retainDays: 2 * 365,
  });

  await forecaster.init();
  const { location } = forecaster;

  console.log(`Site      ${siteId}, ${details.peakPower} kWp, ${timeZone}`);
  console.log(`Location  ${location.latitude.toFixed(3)}, ${location.longitude.toFixed(3)} (${latitude === undefined ? 'from SolarEdge' : 'from .env'})`);
  console.log(`Panels    tilt ${location.tilt}°, facing ${location.azimuth}° (compass)`);

  return { forecaster, timeZone };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function printProfile(profile) {
  if (!profile.multipliers) {
    console.log(`\nSeasonal profile  none (only ${profile.days} usable days of history)`);
    return;
  }

  // The multiplier on the 15th of each month.
  const year = new Date().getFullYear();
  const line = MONTHS.map((month, i) => {
    const date = `${year}-${String(i + 1).padStart(2, '0')}-15`;
    return `${month} ${seasonalMultiplier(profile, date).toFixed(2)}`;
  });

  console.log(`\nSeasonal profile  from ${profile.days} days${profile.shading ? ' (stand-in only: the shading profile is used)' : ''}`);
  console.log(`  ${line.slice(0, 6).join('  ')}`);
  console.log(`  ${line.slice(6).join('  ')}`);

  if (!profile.shading) {
    console.log('\nShading profile   none (not enough hourly history)');
    return;
  }

  // Multipliers as percentages, for the daylight hours. The hour is the one
  // ending then: 09 is 08:00–09:00.
  const hours = Array.from({ length: 15 }, (_, i) => i + 6);
  console.log(`\nShading profile   from ${profile.shading.days} days, ${profile.shading.hours} clear hours (% of a typical clear hour)`);
  console.log(`  hour ${hours.map((h) => String(h).padStart(4)).join('')}`);
  profile.shading.cells.forEach((row, month) => {
    console.log(`  ${MONTHS[month]}  ${hours.map((h) => String(Math.round(row[h] * 100)).padStart(4)).join('')}`);
  });
}

function printBands(bands) {
  if (!bands) {
    console.log('\nForecast range    none (too little history)');
    return;
  }

  const labels = ['clear (<35% cloud)', 'mixed (35-70%)', 'overcast (>70%)'];
  const asPct = (q) => pct(Math.exp(q) - 1).padStart(7);

  console.log(`\nForecast range    from ${bands.days} past day-ahead forecasts (actual vs model)`);
  bands.bins.forEach((bin, i) => {
    console.log(`  ${labels[i].padEnd(20)} P10 ${asPct(bin.q10)}  P50 ${asPct(bin.q50)}  P90 ${asPct(bin.q90)}  (${bin.days} days)`);
  });
}

const range = (day) => `${kwh(day.p50)} kWh  (P10 ${kwh(day.p10)} – P90 ${kwh(day.p90)}, ${Math.round(day.cloudCover ?? 0)}% cloud)`;

async function runForecast({ forecaster, timeZone }) {
  const now = new Date();
  const profile = await forecaster.buildProfile({ now });
  const calibration = await forecaster.calibrate({ now, profile });
  const forecast = await forecaster.forecast({ calibration, profile });
  const { today, tomorrow, powerNowW } = SolarForecaster.summarise(forecast, { now, timeZone });

  printProfile(profile);
  console.log(`\nCalibration       factor ${calibration.factor} from ${calibration.days} days${calibration.calibrated ? '' : ' (too few, using default)'}`
    + `, clip at ${calibration.capW ? `${Math.round(calibration.capW)} W` : 'none'}`);
  printBands(calibration.bands);

  console.log(`\nToday       ${range(today)}`);
  console.log(`Tomorrow    ${range(tomorrow)}`);
  console.log(`Power now   ${Math.round(powerNowW)} W`);

  const tomorrowDate = addDays(localDate(now, timeZone), 1);
  const tomorrowHours = forecast.hours.filter((h) => h.time.startsWith(tomorrowDate) && h.wh > 0);
  const peak = Math.max(...tomorrowHours.map((h) => h.wh), 1);

  console.log('\nTomorrow by hour (energy in the hour ending at):');
  for (const hour of tomorrowHours) {
    const bar = '█'.repeat(Math.round((hour.wh / peak) * 40));
    console.log(`  ${hour.time.slice(11)}  ${String(Math.round(hour.wh)).padStart(5)} Wh  ${bar}`);
  }
}

function summariseErrors(rows, key) {
  const scored = rows.filter((row) => typeof row[key] === 'number');
  const errors = scored.map((row) => row[key] - row.actualWh);
  const totalActual = scored.reduce((sum, row) => sum + row.actualWh, 0);

  const mae = errors.reduce((sum, e) => sum + Math.abs(e), 0) / scored.length;
  const bias = errors.reduce((sum, e) => sum + e, 0) / totalActual;
  const within = (tolerance) => scored
    .filter((row) => Math.abs(row[key] - row.actualWh) <= tolerance * row.actualWh).length / scored.length;

  return {
    mae, wmape: (mae * scored.length) / totalActual, bias, within10: within(0.1), within20: within(0.2),
  };
}

function shadingOptions() {
  const options = {};
  if (opts['shading-cloud'] !== undefined) options.maxCloud = Number(opts['shading-cloud']);
  if (opts['shading-evidence'] !== undefined) options.fullEvidence = Number(opts['shading-evidence']);
  if (opts['shading-spread'] !== undefined) options.hourSpread = Number(opts['shading-spread']);
  return options;
}

async function runBacktest({ forecaster }) {
  const days = Number(opts.days);
  const window = SolarForecaster.CALIBRATION_DAYS;
  const historyDays = SolarForecaster.HISTORY_DAYS;

  if (days > historyDays - window - 1) fail(`--days can be at most ${historyDays - window - 1}.`);

  const today = localDate(new Date(), forecaster.timeZone);
  const testEnd = addDays(today, -1);
  const testStart = addDays(testEnd, -(days - 1));

  // The profile is learned only from the year before the test period, so the
  // test never scores the model on days it learned from.
  const profile = await forecaster.buildProfile({ endDate: addDays(testStart, -2), shadingOptions: shadingOptions() });
  const capW = (await forecaster.getCapW({ endDate: testEnd })) ?? Infinity;

  const history = await forecaster.loadDays({
    startDate: addDays(testEnd, -(historyDays - 1)),
    endDate: testEnd,
    weather: 'dayAhead',
    withHours: true,
  });
  const byDate = Object.fromEntries(history.map((day) => [day.date, day]));

  // The same day under each way of applying the profile.
  const plain = (day) => ({ ...day, hourMultipliers: undefined, multiplier: 1 });
  const variants = {
    seasonal: (day) => ({ ...day, hourMultipliers: undefined, multiplier: seasonalMultiplier(profile, day.date) }),
  };
  // Shading as the whole model, totals included: what the app doesn't do,
  // kept to show why.
  if (profile.shading) {
    variants.shading = (day) => ({ ...day, multiplier: undefined, hourMultipliers: shadingMultipliers(profile.shading, day) });
  }
  const hourly = Object.fromEntries([...Object.keys(variants), ...(profile.shading ? ['hybrid'] : [])]
    .map((key) => [key, { shapeError: 0, p50Error: 0, actual: 0 }]));

  // Replays the app's schedule: the forecast for day D is made on D-1, with a
  // factor and range calibrated early on D-1 from days up to D-2.
  const rows = [];
  for (let date = testStart; date <= testEnd; date = addDays(date, 1)) {
    const day = byDate[date];
    if (!day || !(day.actualWh > 0)) continue;

    const trainEnd = addDays(date, -2);
    const trainStart = addDays(trainEnd, -(window - 1));
    const train = history.filter((d) => d.date >= trainStart && d.date <= trainEnd);
    const upToTrainEnd = history.filter((d) => d.date <= trainEnd);
    const ceilingWh = fitCeiling(history.filter((d) => d.date > addDays(trainEnd, -CEILING_DAYS) && d.date <= trainEnd));

    const phase1 = fitFactor(train.map(plain), { capW, asOfDate: trainEnd });
    const row = {
      date,
      actualWh: day.actualWh,
      cloudCover: day.cloudCover,
      phase1: predictDay(plain(day), phase1.factor, capW),
      uncalibrated: predictDay(plain(day), DEFAULT_FACTOR, Infinity),
    };

    for (const [key, applyProfile] of Object.entries(variants)) {
      const { factor } = fitFactor(train.map(applyProfile), { capW, asOfDate: trainEnd });
      const bands = fitBands(upToTrainEnd.map(applyProfile), { factor, capW });
      const shaped = applyProfile(day);
      const modelWh = predictDay(shaped, factor, capW);
      const { p10, p50, p90 } = applyBands(modelWh, day.cloudCover, bands, { ceilingWh });

      row[key] = modelWh;
      row[`${key}P50`] = p50;
      row[`${key}P10`] = p10;
      row[`${key}P90`] = p90;
      row[`${key}Factor`] = factor;
      if (key === 'seasonal') {
        row.uncorrected = applyBands(modelWh, day.cloudCover, bands, { ceilingWh, correctCloud: false }).p50;
      }

      // Hour by hour, against what was produced: once scaled to the day's
      // actual total (the shape alone), once scaled to P50 (as the app shows).
      if (day.actualHours && modelWh > 0) {
        const predicted = shaped.idealHours.map((idealWh, i) => predictHourWh(idealWh, factor * (shaped.hourMultipliers?.[i] ?? shaped.multiplier ?? 1), capW));
        const total = predicted.reduce((sum, wh) => sum + wh, 0);
        predicted.forEach((wh, i) => {
          const actual = day.actualHours[shaped.hourOfDay[i]] ?? 0;
          hourly[key].shapeError += Math.abs((wh * day.actualWh) / total - actual);
          hourly[key].p50Error += Math.abs((wh * p50) / total - actual);
          hourly[key].actual += actual;
        });
      }
    }

    // What the app does: the seasonal model's P50 for the day, spread over
    // its hours by the shading profile's shape.
    if (profile.shading && day.actualHours && row.seasonalP50 > 0) {
      const shaped = variants.shading(day);
      const predicted = shaped.idealHours.map((idealWh, i) => predictHourWh(idealWh, row.shadingFactor * shaped.hourMultipliers[i], capW));
      const total = predicted.reduce((sum, wh) => sum + wh, 0);
      predicted.forEach((wh, i) => {
        const actual = day.actualHours[shaped.hourOfDay[i]] ?? 0;
        hourly.hybrid.shapeError += Math.abs((wh * day.actualWh) / total - actual);
        hourly.hybrid.p50Error += Math.abs((wh * row.seasonalP50) / total - actual);
        hourly.hybrid.actual += actual;
      });
    }

    const previous = [1, 2, 3, 4, 5, 6, 7]
      .map((n) => byDate[addDays(date, -n)]?.actualWh)
      .filter((wh) => wh > 0);
    row.yesterday = byDate[addDays(date, -1)]?.actualWh > 0 ? byDate[addDays(date, -1)].actualWh : undefined;
    row.week = previous.length ? previous.reduce((a, b) => a + b, 0) / previous.length : undefined;

    rows.push(row);
  }

  if (!rows.length) fail('No days with production in the backtest range.');

  printProfile(profile);

  const best = 'seasonal';
  if (opts.verbose) {
    console.log(`\ndate         actual  phase1      P50   P10–P90         cloud  factor   (${best})`);
    for (const row of rows) {
      const [p10, p50, p90] = [row[`${best}P10`], row[`${best}P50`], row[`${best}P90`]];
      const inRange = row.actualWh >= p10 && row.actualWh <= p90 ? ' ' : '!';
      console.log(`${row.date}  ${kwh(row.actualWh).padStart(6)}  ${kwh(row.phase1).padStart(6)}  ${kwh(p50).padStart(6)}   ${`${kwh(p10)}–${kwh(p90)}`.padEnd(12)}${inRange}  ${String(Math.round(row.cloudCover ?? 0)).padStart(4)}%  ${row[`${best}Factor`]}`);
    }
    console.log('(! = actual outside P10–P90)');
  }

  console.log(`\nBacktest: ${rows.length} days (${rows[0].date} to ${rows[rows.length - 1].date}), day-ahead forecasts, clip at ${Number.isFinite(capW) ? `${Math.round(capW)} W` : 'none'}\n`);
  console.log('Daily totals                   MAE kWh   error %   bias     within ±10%   within ±20%');

  const methods = [
    ['seasonalP50', 'Seasonal + cloud (the app)'],
    ...(profile.shading ? [
      ['shadingP50', 'Shading as the model + cloud'],
      ['shading', 'Shading as the model only'],
    ] : []),
    ['uncorrected', 'Seasonal + ceiling'],
    ['seasonal', 'Seasonal only'],
    ['phase1', 'Phase 1'],
    ['uncalibrated', `Physics only (×${DEFAULT_FACTOR})`],
    ['yesterday', 'Same as yesterday'],
    ['week', '7-day average'],
  ];

  for (const [key, label] of methods) {
    const sum = summariseErrors(rows, key);
    console.log(`${label.padEnd(30)} ${kwh(sum.mae).padStart(7)}   ${(sum.wmape * 100).toFixed(1).padStart(6)}%  ${pct(sum.bias).padStart(7)}   ${(sum.within10 * 100).toFixed(0).padStart(9)}%   ${(sum.within20 * 100).toFixed(0).padStart(9)}%`);
  }

  const labels = {
    seasonal: 'Seasonal shape', shading: 'Shading as the model', hybrid: 'Seasonal total, shading shape (the app)',
  };
  console.log(`\n${'Hourly'.padEnd(40)} shape error   error vs P50`);
  for (const [key, h] of Object.entries(hourly)) {
    if (!h.actual) continue;
    console.log(`${labels[key].padEnd(40)} ${(100 * (h.shapeError / h.actual)).toFixed(1).padStart(10)}%   ${(100 * (h.p50Error / h.actual)).toFixed(1).padStart(11)}%`);
  }

  const share = (test) => `${Math.round((rows.filter(test).length / rows.length) * 100)}%`;
  for (const key of Object.keys(variants)) {
    if (opts.brief) continue;
    console.log(`\nRange (${key === 'seasonal' ? 'the app' : labels[key]}): actual below P10 on ${share((r) => r.actualWh < r[`${key}P10`])} of days, above P90 on ${share((r) => r.actualWh > r[`${key}P90`])} (10% each is ideal).`);
  }
  console.log('error % = total absolute error / total production. bias > 0 means over-forecasting.');
  console.log('Hourly shape error: each day\'s hours scaled to its actual total, so only how the day is spread counts.');
}

try {
  if (!['forecast', 'backtest'].includes(command)) {
    fail(`Unknown command "${command}". Use "forecast" or "backtest".`);
  }

  const context = await setup();
  await (command === 'forecast' ? runForecast : runBacktest)(context);
} catch (err) {
  console.error(`\n${err instanceof UsageError ? err.message : err.stack}`);
  process.exitCode = 1;
}
