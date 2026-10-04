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
  seasonalMultiplier,
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
    'no-cache': { type: 'boolean', default: false },
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

  console.log(`\nSeasonal profile  from ${profile.days} days`);
  console.log(`  ${line.slice(0, 6).join('  ')}`);
  console.log(`  ${line.slice(6).join('  ')}`);
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
  const profile = await forecaster.buildProfile({ endDate: addDays(testStart, -2) });
  const capW = (await forecaster.getCapW({ endDate: testEnd })) ?? Infinity;

  const history = await forecaster.loadDays({
    startDate: addDays(testEnd, -(historyDays - 1)),
    endDate: testEnd,
    weather: 'dayAhead',
    profile,
  });
  const byDate = Object.fromEntries(history.map((day) => [day.date, day]));
  const withoutProfile = (day) => ({ ...day, multiplier: 1 });

  // Replays the app's schedule: the forecast for day D is made on D-1, with a
  // factor and range calibrated early on D-1 from days up to D-2.
  const rows = [];
  for (let date = testStart; date <= testEnd; date = addDays(date, 1)) {
    const day = byDate[date];
    if (!day || !(day.actualWh > 0)) continue;

    const trainEnd = addDays(date, -2);
    const trainStart = addDays(trainEnd, -(window - 1));
    const train = history.filter((d) => d.date >= trainStart && d.date <= trainEnd);

    const phase1 = fitFactor(train.map(withoutProfile), { capW, asOfDate: trainEnd });
    const seasonal = fitFactor(train, { capW, asOfDate: trainEnd });
    const bands = fitBands(history.filter((d) => d.date <= trainEnd), { factor: seasonal.factor, capW });

    const ceilingWh = fitCeiling(history.filter((d) => d.date > addDays(trainEnd, -CEILING_DAYS) && d.date <= trainEnd));

    const seasonalWh = predictDay(day, seasonal.factor, capW);
    const { p10, p50, p90 } = applyBands(seasonalWh, day.cloudCover, bands, { ceilingWh });
    const uncorrected = applyBands(seasonalWh, day.cloudCover, bands, { ceilingWh, correctCloud: false }).p50;

    const previous = [1, 2, 3, 4, 5, 6, 7]
      .map((n) => byDate[addDays(date, -n)]?.actualWh)
      .filter((wh) => wh > 0);

    rows.push({
      date,
      actualWh: day.actualWh,
      cloudCover: day.cloudCover,
      factor: seasonal.factor,
      phase1: predictDay(withoutProfile(day), phase1.factor, capW),
      seasonal: seasonalWh,
      uncorrected,
      p10,
      p50,
      p90,
      uncalibrated: predictDay(withoutProfile(day), DEFAULT_FACTOR, Infinity),
      yesterday: byDate[addDays(date, -1)]?.actualWh > 0 ? byDate[addDays(date, -1)].actualWh : undefined,
      week: previous.length ? previous.reduce((a, b) => a + b, 0) / previous.length : undefined,
    });
  }

  if (!rows.length) fail('No days with production in the backtest range.');

  printProfile(profile);

  if (opts.verbose) {
    console.log('\ndate         actual  phase1      P50   P10–P90         cloud  factor');
    for (const row of rows) {
      const inRange = row.actualWh >= row.p10 && row.actualWh <= row.p90 ? ' ' : '!';
      console.log(`${row.date}  ${kwh(row.actualWh).padStart(6)}  ${kwh(row.phase1).padStart(6)}  ${kwh(row.p50).padStart(6)}   ${`${kwh(row.p10)}–${kwh(row.p90)}`.padEnd(12)}${inRange}  ${String(Math.round(row.cloudCover ?? 0)).padStart(4)}%  ${row.factor}`);
    }
    console.log('(! = actual outside P10–P90)');
  }

  console.log(`\nBacktest: ${rows.length} days (${rows[0].date} to ${rows[rows.length - 1].date}), day-ahead forecasts, clip at ${Number.isFinite(capW) ? `${Math.round(capW)} W` : 'none'}\n`);
  console.log('method                         MAE kWh   error %   bias     within ±10%   within ±20%');

  const methods = [
    ['p50', 'Phase 2 (seasonal + cloud)'],
    ['uncorrected', 'Seasonal + ceiling'],
    ['seasonal', 'Seasonal only'],
    ['phase1', 'Phase 1'],
    ['uncalibrated', `Physics only (×${DEFAULT_FACTOR})`],
    ['yesterday', 'Same as yesterday'],
    ['week', '7-day average'],
  ];

  for (const [key, label] of methods) {
    const s = summariseErrors(rows, key);
    console.log(`${label.padEnd(30)} ${kwh(s.mae).padStart(7)}   ${(s.wmape * 100).toFixed(1).padStart(6)}%  ${pct(s.bias).padStart(7)}   ${(s.within10 * 100).toFixed(0).padStart(9)}%   ${(s.within20 * 100).toFixed(0).padStart(9)}%`);
  }

  const share = (test) => `${Math.round((rows.filter(test).length / rows.length) * 100)}%`;
  console.log(`\nRange: actual below P10 on ${share((r) => r.actualWh < r.p10)} of days, above P90 on ${share((r) => r.actualWh > r.p90)} (10% each is ideal).`);
  console.log('error % = total absolute error / total production. bias > 0 means over-forecasting.');
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
