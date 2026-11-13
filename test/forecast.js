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
 * The solar forecast without a network: the model (lib/solarForecastModel.js), the forecaster's
 * history and requests (lib/SolarForecaster.js, against a stand-in client and Open-Meteo), panel
 * groups, accuracy and today's progress, and the inverter device that runs it
 * (lib/InverterForecast.js). The first blocks are the fork's node:test files, run here.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { manifest } = require('./harness');
const OpenMeteoClient = require('../lib/OpenMeteoClient');
const SolarForecaster = require('../lib/SolarForecaster');
const InverterForecast = require('../lib/InverterForecast');
const {
  DEFAULT_FACTOR, alignedBlocks, applyBands, buildSeasonalProfile, buildShadingProfile, cloudBin, dayOfYear,
  fitBands, fitCeiling, fitFactor, idealHourlyWh, predictDayWh, seasonalMultiplier, shadingMultipliers, summariseDays,
} = require('../lib/solarForecastModel');
const {
  addDays, daysBetween, localDate, localDateTime,
} = require('../lib/localDate');
const { describePlanes, planesFromGroups } = require('../lib/panelLayout');
const {
  MIN_ACCURACY_DAYS, accuracyPercent, dayAheadEntry, recordDayAhead, scoreForecasts,
} = require('../lib/forecastAccuracy');
const {
  MIN_EXPECTED_WH, energyAfter, energyBefore, todayProgress,
} = require('../lib/todayProgress');

const ROOT = path.join(__dirname, '..');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- the fork's test/SolarForecastModel.test.mjs ----------------------------------------------------
{
  test('ideal output matches nameplate at standard test conditions', () => {
    // 1000 W/m² with the cell at 25 °C: ambient 25 - 30 °C of heating = -5 °C.
    assert.ok(Math.abs(idealHourlyWh({ gti: 1000, temperature: -5 }, 6600) - 6600) < 1e-9);
  });

  test('ideal output drops in the heat and is zero at night', () => {
    const cool = idealHourlyWh({ gti: 800, temperature: 10 }, 5000);
    const hot = idealHourlyWh({ gti: 800, temperature: 40 }, 5000);
    assert.ok(hot < cool);
    assert.equal(idealHourlyWh({ gti: 0, temperature: 20 }, 5000), 0);
    assert.equal(idealHourlyWh({ gti: null, temperature: 20 }, 5000), 0);
  });

  test('compass azimuth converts to Open-Meteo convention', () => {
    assert.equal(OpenMeteoClient.toOpenMeteoAzimuth(180), 0);
    assert.equal(OpenMeteoClient.toOpenMeteoAzimuth(90), -90);
    assert.equal(OpenMeteoClient.toOpenMeteoAzimuth(270), 90);
    assert.equal(OpenMeteoClient.toOpenMeteoAzimuth(0), -180);
  });

  test('clipping caps each hour, not the day', () => {
    assert.equal(predictDayWh([1000, 6000, 1000], 1, 5000), 7000);
  });

  const syntheticDays = (factor, count, { capW = Infinity, noise = () => 1 } = {}) => {
    return Array.from({ length: count }, (_, i) => {
      const idealHours = [0, 500, 2500, 5000, 6000, 5000, 2500, 500, 0].map((wh) => wh * (0.5 + (i % 5) / 8));
      return {
        date: addDays('2026-08-01', i),
        idealHours,
        actualWh: predictDayWh(idealHours, factor, capW) * noise(i),
      };
    });
  };

  test('fitFactor recovers the factor from clean data', () => {
    const fit = fitFactor(syntheticDays(0.83, 30));
    assert.equal(fit.calibrated, true);
    assert.ok(Math.abs(fit.factor - 0.83) < 0.005, `got ${fit.factor}`);
  });

  test('fitFactor accounts for clipping', () => {
    const fit = fitFactor(syntheticDays(0.9, 30, { capW: 4000 }), { capW: 4000 });
    assert.ok(Math.abs(fit.factor - 0.9) < 0.005, `got ${fit.factor}`);
  });

  test('fitFactor shrugs off a few outage days', () => {
    const days = syntheticDays(0.8, 30, { noise: (i) => (i % 10 === 3 ? 0.2 : 1) });
    const fit = fitFactor(days);
    assert.ok(Math.abs(fit.factor - 0.8) < 0.01, `got ${fit.factor}`);
  });

  test('fitFactor ignores zero days and falls back with too little data', () => {
    const days = syntheticDays(0.9, 10).map((day, i) => (i < 5 ? { ...day, actualWh: 0 } : day));
    const fit = fitFactor(days);
    assert.equal(fit.calibrated, false);
    assert.equal(fit.factor, DEFAULT_FACTOR);
    assert.equal(fit.days, 5);
  });

  test('local dates follow the time zone, not UTC', () => {
    const instant = new Date('2026-10-04T15:30:00Z');
    assert.equal(localDate(instant, 'Australia/Sydney'), '2026-10-05');
    assert.equal(localDate(instant, 'Europe/Amsterdam'), '2026-10-04');
    assert.equal(localDateTime(instant, 'Australia/Sydney'), '2026-10-05T02:30');
  });

  test('date arithmetic survives DST changes', () => {
    // Sydney DST starts 2026-10-04.
    assert.equal(addDays('2026-10-03', 1), '2026-10-04');
    assert.equal(addDays('2026-10-04', 1), '2026-10-05');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(daysBetween('2026-09-30', '2026-10-05'), 5);
  });

  test('fitFactor fits on top of each day\'s seasonal multiplier', () => {
    const days = syntheticDays(0.8, 30).map((day, i) => {
      const multiplier = i % 2 ? 0.7 : 1.1;
      return { ...day, multiplier, actualWh: day.actualWh * multiplier };
    });
    const fit = fitFactor(days);
    assert.ok(Math.abs(fit.factor - 0.8) < 0.005, `got ${fit.factor}`);
  });

  test('summariseDays weights cloud cover by sunshine', () => {
    const days = summariseDays([
      {
        time: '2026-10-04T03:00', gti: 0, temperature: 10, cloudCover: 100,
      },
      {
        time: '2026-10-04T12:00', gti: 800, temperature: 20, cloudCover: 10,
      },
      {
        time: '2026-10-04T16:00', gti: 200, temperature: 20, cloudCover: 60,
      },
    ], 5000);

    assert.equal(days['2026-10-04'].idealHours.length, 3);
    // The 100% at night counts for nothing; noon outweighs the afternoon 4:1.
    assert.ok(Math.abs(days['2026-10-04'].cloudCover - 20) < 1, `got ${days['2026-10-04'].cloudCover}`);
  });

  test('day of year and the seasonal multiplier lookup', () => {
    assert.equal(dayOfYear('2026-01-01'), 1);
    assert.equal(dayOfYear('2026-12-31'), 365);
    assert.equal(dayOfYear('2028-12-31'), 366);
    assert.equal(seasonalMultiplier(null, '2026-06-15'), 1);
    assert.equal(seasonalMultiplier({ multipliers: null }, '2026-06-15'), 1);
  });

  test('buildSeasonalProfile learns a winter dip', () => {
    // A southern-hemisphere site that loses 30% to shading around midwinter.
    const days = Array.from({ length: 365 }, (_, i) => {
      const date = addDays('2025-10-01', i);
      const winter = Math.abs(dayOfYear(date) - 172) < 45;
      const idealHours = [0, 2000, 5000, 5000, 2000, 0];
      return { date, idealHours, actualWh: predictDayWh(idealHours, winter ? 0.56 : 0.8) };
    });

    const profile = buildSeasonalProfile(days);
    const midwinter = seasonalMultiplier(profile, '2026-06-21');
    const midsummer = seasonalMultiplier(profile, '2026-12-21');

    assert.ok(Math.abs(midwinter / midsummer - 0.7) < 0.02, `got ${midwinter} / ${midsummer}`);
  });

  test('buildSeasonalProfile needs enough history', () => {
    assert.equal(buildSeasonalProfile(syntheticDays(0.8, 30)), null);
  });

  test('cloud cover falls into three groups', () => {
    assert.equal(cloudBin(0), 0);
    assert.equal(cloudBin(34.9), 0);
    assert.equal(cloudBin(35), 1);
    assert.equal(cloudBin(70), 2);
    assert.equal(cloudBin(null), null);
  });

  test('fitBands spreads overcast wider than clear, centred on the median', () => {
    const days = Array.from({ length: 90 }, (_, i) => {
      const idealHours = [1000, 4000, 4000, 1000];
      const overcast = i % 2 === 1;
      // Clear days land within ±5%, overcast within ±50%.
      const spread = ((i % 10) / 9 - 0.5) * (overcast ? 1 : 0.1);
      return {
        date: addDays('2026-01-01', i),
        idealHours,
        cloudCover: overcast ? 90 : 10,
        actualWh: predictDayWh(idealHours, 0.8) * (1 + spread),
      };
    });

    const bands = fitBands(days, { factor: 0.8 });
    const clear = bands.bins[0];
    const overcast = bands.bins[2];

    assert.ok(overcast.q90 - overcast.q10 > 4 * (clear.q90 - clear.q10));
    // No mixed days, so that group falls back to all days pooled.
    assert.equal(bands.bins[1].days, 90);
  });

  test('applyBands caps every estimate at the ceiling', () => {
    const bands = { bins: [null, null, { q10: -0.5, q50: 0, q90: 0.5 }] };
    const range = applyBands(20000, 90, bands, { ceilingWh: 25000 });

    assert.ok(range.p10 < 20000);
    assert.equal(range.p50, 20000);
    assert.equal(range.p90, 25000);
    assert.deepEqual(applyBands(20000, 90, null), { p10: 20000, p50: 20000, p90: 20000 });
  });

  test('fitCeiling sits above the best recent day', () => {
    const days = syntheticDays(0.8, 10);
    const best = Math.max(...days.map((day) => day.actualWh));
    assert.ok(fitCeiling(days) > best);
    assert.equal(fitCeiling([]), null);
  });

  test('summarise splits days and picks the hour in progress', () => {
    const forecast = {
      days: {
        '2026-10-04': { p10: 1, p50: 3000, p90: 4 },
        '2026-10-05': { p10: 2, p50: 3000, p90: 5 },
      },
      hours: [
        { time: '2026-10-04T10:00', wh: 1000 },
        { time: '2026-10-04T11:00', wh: 2000 },
        { time: '2026-10-05T10:00', wh: 3000 },
      ],
    };
    const now = new Date('2026-10-04T00:15:00Z'); // 10:15 in Brisbane (no DST)
    const summary = SolarForecaster.summarise(forecast, { now, timeZone: 'Australia/Brisbane' });

    assert.equal(summary.today.p50, 3000);
    assert.equal(summary.tomorrow.p90, 5);
    assert.equal(summary.powerNowW, 2000);
  });

  test('nextOccurrence picks today if still ahead, else tomorrow', () => {
    const timeZone = 'Australia/Brisbane';
    const now = new Date('2026-10-04T00:15:00Z'); // 10:15 local

    assert.equal(localDateTime(SolarForecaster.nextOccurrence('13:30', { now, timeZone }), timeZone), '2026-10-04T13:30');
    assert.equal(localDateTime(SolarForecaster.nextOccurrence('09:00', { now, timeZone }), timeZone), '2026-10-05T09:00');
  });

  // A year of clear days on a 5 kW array, ideal output a bell from 06:00 to
  // 18:00, delivering 80% of ideal except where shade(date, hour) says less.
  const shadedYear = (shade) => {
    const days = [];
    for (let date = '2025-10-01'; date <= '2026-09-30'; date = addDays(date, 1)) {
      const hourOfDay = [];
      const idealHours = [];
      for (let hour = 6; hour <= 18; hour++) {
        hourOfDay.push(hour);
        idealHours.push(4000 * Math.sin((Math.PI * (hour - 5)) / 14));
      }
      const actualHours = new Array(24).fill(0);
      hourOfDay.forEach((hour, i) => {
        actualHours[hour] = idealHours[i] * 0.8 * shade(date, hour);
      });
      days.push({
        date,
        idealHours,
        hourOfDay,
        cloudHours: hourOfDay.map(() => 10),
        cloudCover: 10,
        actualHours,
        actualWh: actualHours.reduce((a, b) => a + b, 0),
      });
    }
    return days;
  };

  test('the shading profile finds shade at the hours and months it happens', () => {
    // A tree takes half the 08:00 and 09:00 hours in June and July.
    const winterMorning = (date, hour) => (['06', '07'].includes(date.slice(5, 7)) && [8, 9].includes(hour) ? 0.5 : 1);
    const profile = buildShadingProfile(shadedYear(winterMorning), { peakPowerW: 5000 });

    assert.ok(profile);
    const june = profile.cells[5];
    const december = profile.cells[11];
    assert.ok(Math.abs(june[9] - 0.5) < 0.05, `June 09:00 was ${june[9]}`);
    assert.ok(Math.abs(june[13] - 1) < 0.05, `June 13:00 was ${june[13]}`);
    assert.ok(Math.abs(december[9] - 1) < 0.05, `December 09:00 was ${december[9]}`);
    // Night hours have no evidence and stay neutral.
    assert.equal(june[2], 1);
  });

  test('the shading profile needs enough days of hourly history', () => {
    const days = shadedYear(() => 1).slice(0, 30);
    assert.equal(buildShadingProfile(days, { peakPowerW: 5000 }), null);
  });

  test('shading multipliers interpolate between months, whatever the cloud', () => {
    const cells = Array.from({ length: 12 }, (_, month) => new Array(24).fill(month === 5 ? 0.5 : 1));
    const profile = { cells };
    const day = (date, cloud) => ({ date, hourOfDay: [9], cloudHours: [cloud] });

    // On 15 June the June cell applies in full; on 30 June about halfway to July.
    assert.equal(shadingMultipliers(profile, day('2026-06-15', 0))[0], 0.5);
    assert.ok(Math.abs(shadingMultipliers(profile, day('2026-06-30', 0))[0] - 0.75) < 0.02);
    // Wrapping round the year: 1 January sits between December and January.
    assert.equal(shadingMultipliers(profile, day('2026-01-01', 0))[0], 1);
    assert.equal(shadingMultipliers(profile, day('2026-06-15', 80))[0], 0.5);
  });

  test('a day with hour multipliers is predicted hour by hour', () => {
    const day = { idealHours: [1000, 1000], hourMultipliers: [1, 0.5] };
    assert.equal(predictDayWh(day.idealHours, 0.8, Infinity, day.hourMultipliers), 1200);
  });
}

// --- the fork's test/SolarForecasterData.test.mjs ---------------------------------------------------
{
  test('month blocks start on the 1st and only the last is cut short', () => {
    const blocks = alignedBlocks('2025-10-04', '2026-10-03', 'month');

    assert.equal(blocks.length, 13);
    assert.deepEqual(blocks[0], { startDate: '2025-10-01', endDate: '2025-10-31' });
    assert.deepEqual(blocks[3], { startDate: '2026-01-01', endDate: '2026-01-31' });
    assert.deepEqual(blocks[4], { startDate: '2026-02-01', endDate: '2026-02-28' });
    assert.deepEqual(blocks[12], { startDate: '2026-10-01', endDate: '2026-10-03' });
  });

  test('month blocks cross the year end', () => {
    assert.deepEqual(alignedBlocks('2026-12-15', '2027-01-10', 'month'), [
      { startDate: '2026-12-01', endDate: '2026-12-31' },
      { startDate: '2027-01-01', endDate: '2027-01-10' },
    ]);
  });

  test('day blocks keep fixed boundaries as the range slides', () => {
    const today = alignedBlocks('2026-09-06', '2026-10-03', 7);
    const tomorrow = alignedBlocks('2026-09-07', '2026-10-04', 7);

    for (const block of today) {
      assert.ok(daysBetween(block.startDate, block.endDate) < 7);
    }

    // Every complete block of today's range reappears unchanged tomorrow.
    const complete = today.filter((block) => daysBetween(block.startDate, block.endDate) === 6);
    for (const block of complete) {
      assert.ok(tomorrow.some((b) => b.startDate === block.startDate && b.endDate === block.endDate));
    }
  });

  // A stand-in for SolarEdgeCloudClient that records calls and returns one value per day
  // (energy) or per 15 minutes (power), shaped like the dashboard endpoints.
  const fakeSolarEdge = () => {
    const calls = [];
    const days = (startDate, endDate) => {
      const out = [];
      for (let d = startDate; d <= endDate; d = addDays(d, 1)) out.push(d);
      return out;
    };

    return {
      calls,
      async getSiteDetails() {
        calls.push('details');
        return { peakPower: 5.72, latitude: -37.81, longitude: 144.96 };
      },
      async getSiteEnergyChart({
        startDate, endDate, timeUnit, measurementTypes,
      }) {
        calls.push(`energy ${startDate}..${endDate}`);
        assert.equal(timeUnit, 'days');
        assert.deepEqual(measurementTypes, ['production']);
        assert.ok(daysBetween(startDate, endDate) < 93, 'energy request over 93 days');
        return {
          chart: {
            measurements: days(startDate, endDate).map((d) => ({ measurementTime: `${d}T00:00:00+10:00`, production: 10000 })),
          },
        };
      },
      async getSitePowerChart({
        startDate, endDate, timeUnit, measurementTypes,
      }) {
        calls.push(`power ${startDate}..${endDate}`);
        assert.equal(timeUnit, 'quarter-hours');
        assert.deepEqual(measurementTypes, ['production']);
        assert.ok(daysBetween(startDate, endDate) < 8, 'power request over 8 days');
        return {
          measurements: days(startDate, endDate).map((d) => ({ measurementTime: `${d}T12:00:00+10:00`, production: d === '2026-09-20' ? 4000 : 2000 })),
        };
      },
    };
  };

  // Noon in Melbourne on the given date, as the forecaster's clock.
  const at = (date) => () => new Date(`${date}T02:00:00Z`);

  // An in-memory stand-in for the device store.
  const memoryStore = () => {
    const store = { saved: null, saves: 0 };
    store.load = async () => (store.saved ? JSON.parse(JSON.stringify(store.saved)) : null);
    store.save = async (history) => {
      store.saved = JSON.parse(JSON.stringify(history));
      store.saves += 1;
    };
    return store;
  };

  const forecasterFor = (api, options = {}) => {
    return new SolarForecaster({
      client: api, siteId: 1, timeZone: 'Australia/Melbourne', now: at('2026-10-04'), ...options,
    });
  };

  test('forecaster fetches history in blocks and only new days the next day', async () => {
    const api = fakeSolarEdge();
    const historyStore = memoryStore();
    const forecaster = forecasterFor(api, { historyStore });

    const energy = await forecaster.getEnergy({ startDate: '2025-10-04', endDate: '2026-10-03' });
    assert.equal(energy.length, 365);
    assert.equal(energy[0].date, '2025-10-04');
    assert.equal(energy[364].date, '2026-10-03');
    assert.ok(energy.every((e) => e.value === 10000));
    assert.equal(api.calls.filter((c) => c.startsWith('energy')).length, 13);

    const capW = await forecaster.getCapW({ endDate: '2026-10-03' });
    assert.equal(capW, 4000 * SolarForecaster.CAP_HEADROOM);
    assert.ok(api.calls.filter((c) => c.startsWith('power')).length <= 5);

    // The next day only the block holding the new day is fetched again.
    api.calls.length = 0;
    forecaster.now = at('2026-10-05');
    await forecaster.getEnergy({ startDate: '2025-10-05', endDate: '2026-10-04' });
    await forecaster.getCapW({ endDate: '2026-10-04' });
    assert.deepEqual(api.calls, ['energy 2026-10-01..2026-10-04', 'power 2026-10-01..2026-10-04']);
  });

  test('history survives a restart through the store', async () => {
    const historyStore = memoryStore();
    await forecasterFor(fakeSolarEdge(), { historyStore }).getEnergy({ startDate: '2026-08-01', endDate: '2026-10-03' });
    assert.ok(historyStore.saves > 0);

    // A new instance, as after a Homey restart, needs nothing from SolarEdge.
    const api = fakeSolarEdge();
    const energy = await forecasterFor(api, { historyStore }).getEnergy({ startDate: '2026-08-01', endDate: '2026-10-03' });
    assert.equal(energy.length, 64);
    assert.deepEqual(api.calls, []);
  });

  test('history for another site is ignored', async () => {
    const historyStore = memoryStore();
    await forecasterFor(fakeSolarEdge(), { historyStore }).getEnergy({ startDate: '2026-09-01', endDate: '2026-09-30' });

    const api = fakeSolarEdge();
    await forecasterFor(api, { historyStore, siteId: 2 }).getEnergy({ startDate: '2026-09-01', endDate: '2026-09-30' });
    assert.deepEqual(api.calls, ['energy 2026-09-01..2026-09-30']);
  });

  test('today is never stored, and missing days are asked for again only while recent', async () => {
    const api = fakeSolarEdge();
    const { getSiteEnergyChart } = api;
    // SolarEdge has nothing for 2026-08-10 or 2026-10-02.
    api.getSiteEnergyChart = async (args) => {
      const result = await getSiteEnergyChart(args);
      result.chart.measurements = result.chart.measurements
        .filter((m) => !['2026-08-10', '2026-10-02'].includes(m.measurementTime.slice(0, 10)));
      return result;
    };

    const forecaster = forecasterFor(api);
    const energy = await forecaster.getEnergy({ startDate: '2026-08-01', endDate: '2026-10-04' });
    assert.equal(energy.find((e) => e.date === '2026-08-10').value, null);
    assert.equal(energy.find((e) => e.date === '2026-10-04').value, null);
    assert.ok(!('2026-10-04' in forecaster.history.energy));

    // 2026-10-02 is recent enough to be checked again; 2026-08-10 isn't.
    api.calls.length = 0;
    await forecaster.getEnergy({ startDate: '2026-08-01', endDate: '2026-10-03' });
    assert.deepEqual(api.calls, ['energy 2026-10-01..2026-10-03']);
  });

  test('dates past the retention window are dropped when the history is saved', async () => {
    const historyStore = memoryStore();
    const forecaster = forecasterFor(fakeSolarEdge(), { historyStore, retainDays: 40 });
    await forecaster.getEnergy({ startDate: '2026-08-01', endDate: '2026-10-03' });

    const dates = Object.keys(historyStore.saved.energy).sort();
    assert.equal(dates[0], '2026-08-25');
  });

  test('15-minute power rolls up into energy per hour ending, plus the peak', () => {
    const days = SolarForecaster.rollUpPower([
      { measurementTime: '2026-10-03T10:00:00+10:00', production: 1000 },
      { measurementTime: '2026-10-03T10:15:00+10:00', production: 2000 },
      { measurementTime: '2026-10-03T10:30:00+10:00', production: 3000 },
      { measurementTime: '2026-10-03T10:45:00+10:00', production: 4000 },
      { measurementTime: '2026-10-03T11:00:00+10:00', production: 400 },
      { measurementTime: '2026-10-03T23:45:00+10:00', production: 5 },
      { measurementTime: '2026-10-03T12:00:00+10:00', production: null },
    ]);

    // 10:00–11:00 is Open-Meteo's 11:00 hour.
    assert.equal(days['2026-10-03'].hours[11], 2500);
    assert.equal(days['2026-10-03'].hours[12], 100);
    assert.equal(days['2026-10-03'].hours[10], 0);
    assert.equal(days['2026-10-03'].hours.length, 24);
    assert.equal(days['2026-10-03'].maxW, 4000);
  });

  test('concurrent requests for the same history share in-flight blocks', async () => {
    const api = fakeSolarEdge();
    const forecaster = forecasterFor(api);

    // What happens when Open-Meteo fails: loadDays() rejects while its
    // getEnergy() keeps running, and the next step asks for the same year.
    const range = { startDate: '2025-10-04', endDate: '2026-10-03' };
    const [a, b] = await Promise.all([forecaster.getEnergy(range), forecaster.getEnergy(range)]);

    assert.equal(a.length, 365);
    assert.deepEqual(a, b);
    assert.equal(api.calls.filter((c) => c.startsWith('energy')).length, 13);
  });

  test('a block that fails is fetched again next time', async () => {
    const api = fakeSolarEdge();
    const { getSiteEnergyChart } = api;
    let failures = 1;
    api.getSiteEnergyChart = async (args) => {
      if (args.startDate === '2026-09-01' && failures-- > 0) throw new Error('boom');
      return getSiteEnergyChart(args);
    };

    const forecaster = forecasterFor(api);
    const range = { startDate: '2026-08-01', endDate: '2026-10-03' };

    await assert.rejects(forecaster.getEnergy(range), /boom/);
    const energy = await forecaster.getEnergy(range);
    assert.equal(energy.length, 64);
    // Blocks are fetched in order, so the first attempt stopped at September.
    // The retry reuses August and fetches the rest.
    assert.deepEqual(api.calls, [
      'energy 2026-08-01..2026-08-31',
      'energy 2026-09-01..2026-09-30',
      'energy 2026-10-01..2026-10-03',
    ]);
  });

  test('forecast hours follow the shading shape and add up to the seasonal P50', async () => {
    // Two days of a flat 600 W/m² from 07:00 to 17:00.
    const hours = [];
    for (const date of ['2026-06-15', '2026-06-16']) {
      for (let hour = 0; hour < 24; hour++) {
        hours.push({
          time: `${date}T${String(hour).padStart(2, '0')}:00`, gti: hour >= 7 && hour <= 17 ? 600 : 0, temperature: 10, cloudCover: 20,
        });
      }
    }
    const openMeteo = { getForecast: async () => hours };
    const forecaster = forecasterFor(fakeSolarEdge(), { openMeteo });
    const calibration = {
      factor: 0.8, capW: Infinity, peakPowerW: 5720, bands: null, ceilingWh: null,
    };

    const plain = await forecaster.forecast({ calibration, profile: null });
    // Half the 09:00 hour shaded in June.
    const cells = Array.from({ length: 12 }, () => new Array(24).fill(1));
    cells[5][9] = 0.5;
    const shaded = await forecaster.forecast({ calibration, profile: { multipliers: null, shading: { cells } } });

    const sumFor = (forecast, date) => forecast.hours.filter((h) => h.time.startsWith(date)).reduce((sum, h) => sum + h.wh, 0);
    const at = (forecast, time) => forecast.hours.find((h) => h.time === time).wh;

    // The daily total is the seasonal model's, untouched by the shading profile.
    assert.equal(shaded.days['2026-06-15'].p50, plain.days['2026-06-15'].p50);
    assert.ok(Math.abs(sumFor(shaded, '2026-06-15') - shaded.days['2026-06-15'].p50) < 1e-6);
    // The shaded hour gives up energy to the others.
    assert.ok(at(shaded, '2026-06-15T09:00') < at(plain, '2026-06-15T09:00') * 0.6);
    assert.ok(at(shaded, '2026-06-15T12:00') > at(plain, '2026-06-15T12:00'));
    assert.equal(at(shaded, '2026-06-15T03:00'), 0);
  });
}

// --- the fork's test/PanelLayout.test.mjs -----------------------------------------------------------
{
  const unused = { panels: 0, tilt: 20, azimuth: null };

  test('one group needs no panel count and takes the whole array', () => {
    assert.deepEqual(planesFromGroups([{ panels: 0, tilt: 25, azimuth: 315 }, unused, unused]), [
      { tilt: 25, azimuth: 315, share: 1 },
    ]);
  });

  test('groups are weighted by their panels, and empty ones dropped', () => {
    // The author's site, by compass: 13 panels facing 306°, 9 facing 33°.
    const planes = planesFromGroups([
      { panels: 13, tilt: 20, azimuth: 306 },
      { panels: 9, tilt: 20, azimuth: 33 },
      unused,
    ]);
    assert.deepEqual(planes.map((p) => [p.panels, p.azimuth]), [[13, 306], [9, 33]]);
    assert.ok(Math.abs(planes[0].share - 13 / 22) < 1e-12);
    assert.equal(describePlanes(planes), '13 × 20°/306°, 9 × 20°/33°');
  });

  test('a second group without a count for the first is refused with a reason', () => {
    assert.throws(
      () => planesFromGroups([{ panels: 0, tilt: 20, azimuth: 306 }, { panels: 9, tilt: 20, azimuth: 33 }, unused]),
      /how many panels the first group has/,
    );
  });

  test('groups that do not add up carry a code for the device to word', () => {
    assert.throws(
      () => planesFromGroups([{ panels: 0, tilt: 20, azimuth: 306 }, { panels: 9, tilt: 20, azimuth: 33 }, unused]),
      (error) => error.code === 'FORECAST_FIRST_GROUP',
    );
  });

  const site = {
    async getSiteDetails() {
      return { peakPower: 5.72, latitude: -37.81, longitude: 144.96 };
    },
  };

  test('a plane left facing "the equator" faces north in the southern hemisphere', async () => {
    const forecaster = new SolarForecaster({
      client: site, siteId: 1, timeZone: 'Australia/Melbourne', planes: planesFromGroups([{ panels: 0, tilt: 20, azimuth: null }, unused, unused]),
    });
    await forecaster.init();
    assert.deepEqual(forecaster.location.planes, [{ tilt: 20, azimuth: 0, share: 1 }]);
    assert.equal(describePlanes(forecaster.location.planes), '100% × 20°/0°');
  });

  test('irradiance is blended across planes by their share', async () => {
    // A fake Open-Meteo where a plane's irradiance is its azimuth, so the blend
    // is easy to check.
    const openMeteo = {
      async getForecast({ azimuth }) {
        return [{
          time: '2026-10-05T12:00', gti: azimuth, temperature: 15, cloudCover: 10,
        }];
      },
    };
    const forecaster = new SolarForecaster({
      client: site, openMeteo, siteId: 1, timeZone: 'Australia/Melbourne', planes: planesFromGroups([{ panels: 3, tilt: 20, azimuth: 300 }, { panels: 1, tilt: 20, azimuth: 100 }, unused]),
    });
    await forecaster.init();

    const [hour] = await forecaster.getHours('getForecast', { forecastDays: 2 });
    assert.equal(hour.gti, 300 * 0.75 + 100 * 0.25);
    assert.equal(hour.cloudCover, 10);
  });
}

// --- the fork's test/ForecastAccuracy.test.mjs ------------------------------------------------------
{
  test('the day-ahead entry keeps the day\'s range and its hours', () => {
    const entry = dayAheadEntry('2026-10-06', { p10: 9000.4, p50: 15000.6, p90: 20000 }, [
      { time: '2026-10-05T12:00', wh: 999 },
      { time: '2026-10-06T11:00', wh: 1200.4 },
      { time: '2026-10-06T12:00', wh: 1500 },
    ]);

    assert.deepEqual([entry.p10, entry.p50, entry.p90], [9000, 15001, 20000]);
    assert.equal(entry.hours.length, 24);
    assert.equal(entry.hours[11], 1200);
    assert.equal(entry.hours[12], 1500);
    assert.equal(entry.hours.reduce((a, b) => a + b, 0), 2700);
  });

  test('a later forecast for the same day replaces the earlier one, and old days go', () => {
    let log = recordDayAhead({}, '2026-08-01', { p50: 1 });
    log = recordDayAhead(log, '2026-10-06', { p50: 2 });
    log = recordDayAhead(log, '2026-10-06', { p50: 3 });

    assert.deepEqual(Object.keys(log), ['2026-10-06']);
    assert.equal(log['2026-10-06'].p50, 3);
  });

  // Ten days: forecast 10 kWh (range 8–12) each day, actual alternating 9 and
  // 13 kWh; hourly, the forecast puts it all at noon and the day splits it
  // across noon and 13:00.
  const tenDays = () => {
    const log = {};
    const energy = {};
    const power = {};
    for (let i = 0; i < 10; i++) {
      const date = addDays('2026-09-21', i);
      const hours = new Array(24).fill(0);
      hours[12] = 10000;
      log[date] = {
        p10: 8000, p50: 10000, p90: 12000, hours,
      };
      energy[date] = i % 2 ? 13000 : 9000;
      const actualHours = new Array(24).fill(0);
      actualHours[12] = energy[date] / 2;
      actualHours[13] = energy[date] / 2;
      power[date] = { hours: actualHours };
    }
    return { log, energy, power };
  };

  test('forecasts are scored against what was produced', () => {
    const { log, energy, power } = tenDays();
    const score = scoreForecasts(log, { energy, power }, { endDate: '2026-09-30' });

    assert.equal(score.days, 10);
    // |10-9| and |10-13| alternate: 20 kWh missed of 110 produced.
    assert.ok(Math.abs(score.error - 20 / 110) < 1e-12);
    // 100 kWh forecast against 110 produced: 10 kWh under.
    assert.ok(Math.abs(score.bias - (-10 / 110)) < 1e-12);
    // 9 kWh is in range, 13 kWh is above P90.
    assert.equal(score.coverage, 0.5);
    assert.ok(score.hourlyError > score.error);
    assert.equal(accuracyPercent(score), 82);
  });

  test('days without production or outside the window aren\'t scored, and too few give nothing', () => {
    const { log, energy, power } = tenDays();
    energy['2026-09-25'] = null;
    energy['2026-09-26'] = 0;
    const score = scoreForecasts(log, { energy, power }, { endDate: '2026-09-30' });
    assert.equal(score.days, 8);

    const narrow = scoreForecasts(log, { energy, power }, { endDate: '2026-09-30', days: MIN_ACCURACY_DAYS - 1 });
    assert.equal(narrow, null);
    assert.equal(accuracyPercent(null), null);
  });

  test('hourly error is left out when there is no hourly production', () => {
    const { log, energy } = tenDays();
    const score = scoreForecasts(log, { energy, power: {} }, { endDate: '2026-09-30' });
    assert.equal(score.hourlyError, null);
  });
}

// --- the fork's test/TodayProgress.test.mjs ---------------------------------------------------------
{
  // 1 kWh in each hour ending 08:00 to 18:00 (07:00–18:00), 11 kWh in all.
  const flat = Array.from({ length: 24 }, (_, h) => (h >= 8 && h <= 18 ? 1000 : 0));

  test('energy before and after a time splits the current hour pro rata', () => {
    // 10:30: hours ending 08, 09, 10 are over, and half of 10:00–11:00.
    assert.equal(energyBefore(flat, { hour: 10, minute: 30 }), 3500);
    assert.equal(energyAfter(flat, { hour: 10, minute: 30 }), 7500);
    assert.equal(energyBefore(flat, { hour: 6, minute: 0 }), 0);
    assert.equal(energyBefore(flat, { hour: 23, minute: 59 }), 11000);
  });

  test('today is compared with the plan, and projected from the latest forecast', () => {
    const progress = todayProgress({
      planHours: flat,
      // The latest forecast has turned cloudier for the afternoon.
      latestHours: flat.map((wh, h) => (h > 12 ? wh / 2 : wh)),
      producedWh: 3000,
      at: { hour: 12, minute: 0 },
    });

    // By noon the plan had 5 kWh; 3 kWh came.
    assert.equal(progress.expectedWh, 5000);
    assert.equal(progress.vsForecast, 0.6);
    // Hours ending 13 to 18 at half: 3 kWh to come.
    assert.equal(progress.remainingWh, 3000);
    assert.equal(progress.projectedWh, 6000);
  });

  test('no comparison until enough is expected, and none without a plan', () => {
    const early = todayProgress({
      planHours: flat, latestHours: flat, producedWh: 200, at: { hour: 7, minute: 45 },
    });
    assert.ok(early.expectedWh < MIN_EXPECTED_WH);
    assert.equal(early.vsForecast, null);
    assert.equal(early.projectedWh, 200 + 11000 - 750);

    const noPlan = todayProgress({
      planHours: null, latestHours: flat, producedWh: 5000, at: { hour: 13, minute: 0 },
    });
    assert.equal(noPlan.vsForecast, null);
    assert.equal(noPlan.remainingWh, 5000);

    // By 13:00 the plan had 6 kWh (hours ending 08 to 13); exactly that came.
    const noLatest = todayProgress({
      planHours: flat, latestHours: null, producedWh: 6000, at: { hour: 13, minute: 0 },
    });
    assert.equal(noLatest.projectedWh, null);
    assert.equal(noLatest.vsForecast, 1);
  });
}

// --- the inverter device that runs the forecast (lib/InverterForecast.js) -----------------------
{
  const TIME_ZONE = 'Australia/Melbourne';
  const datesOf = (startDate, endDate) => {
    const out = [];
    for (let date = startDate; date <= endDate; date = addDays(date, 1)) out.push(date);
    return out;
  };
  // a clear day: irradiance from 07:00 to 18:00 peaking at 13:00, every day
  const gtiAt = (hour) => Math.max(0, 900 * Math.sin(((hour - 7) / 12) * Math.PI));
  const hoursOf = (dates) => dates.flatMap((date) => Array.from({ length: 24 }, (_, hour) => ({
    time: `${date}T${String(hour).padStart(2, '0')}:00`, gti: gtiAt(hour), temperature: 15, cloudCover: 20,
  })));
  const fakeOpenMeteo = () => {
    const calls = [];
    const range = (method) => async ({ startDate, endDate }) => {
      calls.push(method);
      return hoursOf(datesOf(startDate, endDate));
    };
    return {
      calls,
      getHistoricalForecast: range('archive'),
      getDayAheadHistory: range('dayAhead'),
      getForecast: async ({ timeZone }) => {
        calls.push('forecast');
        const today = localDate(new Date(), timeZone);
        return hoursOf([today, addDays(today, 1)]);
      },
    };
  };
  // the account's client as the forecast and the device use it; 25 kWh a day, 3 kW at noon
  const fakeClient = (serials = []) => ({
    getSites: async () => ({ 1: { id: 1, timezone: TIME_ZONE } }),
    getSiteEquipment: async () => ({ inverters: { details: [{ serialNumbers: serials }] } }),
    getSiteDetails: async () => ({ peakPower: 5.72, latitude: -37.81, longitude: 144.96 }),
    getSiteEnergyChart: async ({ startDate, endDate }) => ({
      chart: { measurements: datesOf(startDate, endDate).map((date) => ({ measurementTime: `${date}T00:00:00+10:00`, production: 25000 })) },
    }),
    getSitePowerChart: async ({ startDate, endDate }) => ({
      measurements: datesOf(startDate, endDate).flatMap((date) => Array.from({ length: 96 }, (_, slot) => ({
        measurementTime: `${date}T${String(Math.floor(slot / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}:00+10:00`,
        production: Math.round(gtiAt(slot / 4 + 0.5) * 3.3),
      }))),
    }),
  });

  const DeviceClass = require(path.join(ROOT, 'drivers', 'inverter', 'device.js')); // eslint-disable-line import/no-dynamic-require, global-require
  const driverManifest = manifest.drivers.find((driver) => driver.id === 'inverter');

  /** An inverter device with the forecast's Flow trigger recorded in `triggered`. */
  const newInverter = ({ data = { siteId: 1 }, client = fakeClient(), settings = {} } = {}) => {
    const device = new DeviceClass({ driverManifest, data, settings: { ...settings } });
    const triggered = [];
    device.homey = {
      ...device.homey,
      flow: { getDeviceTriggerCard: (id) => ({ trigger: async (target, tokens) => triggered.push({ id, target, tokens }) }) },
    };
    device.client = client;
    const openMeteo = fakeOpenMeteo();
    device.solarForecast = new InverterForecast(device, { openMeteo });
    return {
      device, triggered, openMeteo,
    };
  };

  test('the site device runs the forecast: its tiles, the Flow trigger and the store', async () => {
    const { device, triggered, openMeteo } = newInverter();
    await device.solarForecast.update();

    assert.deepEqual(device.problems, []);
    for (const capability of InverterForecast.CAPABILITIES) {
      assert.ok(device.hasCapability(capability), `no ${capability}`);
      assert.equal(device.getStoreValue('seenCaps')[capability], true);
    }
    // in the tile order: the forecast next to the power, accuracy after the energy meters
    const caps = device.getCapabilities();
    assert.ok(caps.indexOf('solar_forecast_power') < caps.indexOf('meter_power.day'));
    assert.ok(caps.indexOf('meter_power') < caps.indexOf('solar_forecast_accuracy'));

    const tomorrow = device.getCapabilityValue('solar_forecast_tomorrow');
    assert.ok(tomorrow > 5 && tomorrow < 40, `tomorrow ${tomorrow} kWh`);
    assert.ok(device.getCapabilityValue('solar_forecast_today') > 0);
    assert.equal(typeof device.getCapabilityValue('solar_forecast_power'), 'number');
    // no day-ahead forecasts kept yet: no score, the label says how many it needs
    assert.equal(device.getCapabilityValue('solar_forecast_accuracy'), null);
    assert.ok(device.getSettings().forecast_accuracy.includes(String(MIN_ACCURACY_DAYS)));

    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].id, 'solar_forecast_tomorrow_updated');
    assert.equal(triggered[0].target, device);
    assert.equal(triggered[0].tokens.forecast, tomorrow);
    assert.ok(triggered[0].tokens.forecast_low <= tomorrow && tomorrow <= triggered[0].tokens.forecast_high);
    assert.ok(manifest.flow.triggers.some((card) => card.id === 'solar_forecast_tomorrow_updated'));

    for (const key of ['forecastHistory', 'forecastProfile', 'forecastCalibration', 'forecastLog', 'forecastTodayBaseline']) {
      assert.ok(device.getStoreValue(key), `store ${key}`);
    }
    assert.ok(openMeteo.calls.includes('archive') && openMeteo.calls.includes('dayAhead') && openMeteo.calls.includes('forecast'));

    // the next tick within the hour uses what it has: no requests, no second trigger
    openMeteo.calls.length = 0;
    await device.solarForecast.update();
    assert.deepEqual(openMeteo.calls, []);
    assert.equal(triggered.length, 1);

    // the Flow conditions answer from it
    assert.equal(device.forecastTomorrowAbove('p50', tomorrow - 0.5), true);
    assert.equal(device.forecastTomorrowAbove('p50', tomorrow + 0.5), false);
    assert.equal(device.forecastPowerAtAbove('13:00', 100), true);
    assert.equal(device.forecastPowerAtAbove('02:00', 0), false);
  });

  test('today\'s production fills projected and remaining today', async () => {
    const { device } = newInverter();
    await device.solarForecast.update();
    const today = localDate(new Date(), TIME_ZONE);
    await device.solarForecast.noteProduced(today, 4000);
    const projected = device.getCapabilityValue('solar_forecast_projected');
    const remaining = device.getCapabilityValue('solar_forecast_remaining');
    assert.equal(typeof remaining, 'number');
    assert.ok(Math.abs(projected - (4 + remaining)) <= 0.15, `projected ${projected}, remaining ${remaining}`);
    // yesterday's figure is not today's
    await device.solarForecast.noteProduced(addDays(today, -1), 9000);
    assert.equal(device.getCapabilityValue('solar_forecast_projected'), null);
  });

  test('a failed refresh keeps today\'s forecast and its tiles moving', async () => {
    const { device, triggered, openMeteo } = newInverter();
    const fc = device.solarForecast;
    await fc.update();
    const tomorrow = device.getCapabilityValue('solar_forecast_tomorrow');
    openMeteo.getForecast = async () => {
      throw new Error('Open-Meteo request timed out after 30000ms');
    };

    // the hourly refresh fails: the tiles are still set from the forecast it has, and it's logged
    fc.fetchedAt = 0;
    await device.setCapabilityValue('solar_forecast_power', -1);
    await fc.update();
    assert.equal(typeof device.getCapabilityValue('solar_forecast_power'), 'number');
    assert.notEqual(device.getCapabilityValue('solar_forecast_power'), -1);
    assert.equal(device.getCapabilityValue('solar_forecast_tomorrow'), tomorrow);
    assert.equal(device.problems.length, 1);
    assert.match(device.problems[0], /keeping the one from .*timed out/);
    assert.equal(fc.fetchedAt, 0, 'tried again next tick');

    // a new day with yesterday's forecast: today from it, tomorrow unknown rather than zero
    const today = localDate(new Date(), TIME_ZONE);
    delete fc.forecast.days[addDays(today, 1)];
    fc.forecastDate = addDays(today, -1);
    await fc.update();
    assert.ok(device.getCapabilityValue('solar_forecast_today') > 0);
    assert.equal(device.getCapabilityValue('solar_forecast_tomorrow'), null);
    assert.throws(() => device.forecastTomorrowAbove('p50', 1), /isn’t available yet/);
    assert.equal(triggered.length, 1, 'no trigger for an unknown tomorrow');

    // nothing for today at all: the tiles are cleared and the conditions say so
    delete fc.forecast.days[today];
    await assert.rejects(fc.update(), /timed out/);
    for (const capability of ['solar_forecast_power', 'solar_forecast_today', 'solar_forecast_tomorrow']) {
      assert.equal(device.getCapabilityValue(capability), null, capability);
    }
    assert.throws(() => device.forecastPowerAtAbove('12:00', 1), /isn’t available yet/);

    // once Open-Meteo answers again, all is back
    openMeteo.getForecast = fakeOpenMeteo().getForecast;
    await fc.update();
    assert.equal(device.getCapabilityValue('solar_forecast_tomorrow'), tomorrow);
  });

  test('a failed calibration keeps the previous one and still forecasts', async () => {
    const { device, openMeteo } = newInverter();
    const fc = device.solarForecast;
    await fc.update();
    const calibration = device.getStoreValue('forecastCalibration');
    // due again (another day's), but the history it needs doesn't come
    await device.setStoreValue('forecastCalibration', { ...calibration, date: '2000-01-01' });
    fc.calibrationAttempt = 0;
    fc.timeZone = 'Etc/GMT-14'; // past CALIBRATE_AFTER_HOUR whenever the test runs
    openMeteo.getDayAheadHistory = async () => {
      throw new Error('previous-runs down');
    };
    fc.forecaster.history = null;
    await fc.update();
    assert.deepEqual(device.problems, ['error: Error calibrating the forecast: previous-runs down']);
    assert.equal(device.getStoreValue('forecastCalibration').date, '2000-01-01');
    assert.equal(typeof device.getCapabilityValue('solar_forecast_power'), 'number');
  });

  test('on a site with several inverters only the lowest serial runs it', async () => {
    const serials = ['7E1DBB39-B2', '7E1DBB12-A1'];
    const first = newInverter({ data: { siteId: 1, serialNumber: '7E1DBB12-A1' }, client: fakeClient(serials) });
    const second = newInverter({ data: { siteId: 1, serialNumber: '7E1DBB39-B2' }, client: fakeClient(serials) });
    assert.equal(await first.device.solarForecast.runsForecast(), true);
    assert.equal(await second.device.solarForecast.runsForecast(), false);
    await second.device.solarForecast.update();
    assert.ok(!second.device.hasCapability('solar_forecast_tomorrow'));
    assert.deepEqual(second.openMeteo.calls, []);
    // the site's only inverter is the whole site
    assert.equal(await newInverter({ data: { siteId: 1, serialNumber: 'X' }, client: fakeClient(['X']) }).device.solarForecast.runsForecast(), true);
  });

  test('before the forecast is in, the conditions say so', () => {
    const { device } = newInverter();
    assert.throws(() => device.forecastTomorrowAbove('p50', 1), /isn’t available yet/);
    assert.throws(() => device.forecastPowerAtAbove('12:00', 1), /isn’t available yet/);
  });

  test('panel groups that do not add up are refused in the user\'s words; the accuracy label is no change', () => {
    const { device } = newInverter();
    const bad = { forecast_panels: 0, forecast_panels_2: 9 };
    assert.throws(() => device.solarForecast.checkSettings(bad, ['forecast_panels_2']), (error) => error.message.startsWith('Set how many panels the first group has'));
    device.solarForecast.checkSettings(bad, ['forecast_accuracy']);
    device.solarForecast.checkSettings({ forecast_panels: 13, forecast_panels_2: 9 }, ['forecast_panels', 'forecast_panels_2']);
  });

  test('a device paired with the forecast keeps its tiles before its first forecast', () => {
    const capabilities = ['measure_power', ...InverterForecast.CAPABILITIES, 'meter_power'];
    const device = new DeviceClass({
      driverManifest, data: { siteId: 1 }, settings: {}, capabilities,
    });
    const list = device.capabilityList();
    InverterForecast.CAPABILITIES.forEach((capability) => assert.ok(list.includes(capability), capability));
    const fresh = new DeviceClass({ driverManifest, data: { siteId: 1 }, settings: {} });
    assert.ok(!fresh.capabilityList().includes('solar_forecast_tomorrow'));
  });

  test('Open-Meteo azimuths and the hourly answer', () => {
    assert.deepEqual(OpenMeteoClient.toHours({
      time: ['2026-10-05T12:00'], global_tilted_irradiance_previous_day1: [500], temperature_2m_previous_day1: [18], cloud_cover_previous_day1: [40],
    }, '_previous_day1'), [{
      time: '2026-10-05T12:00', gti: 500, temperature: 18, cloudCover: 40,
    }]);
    assert.equal(localDateTime(new Date('2026-10-05T02:00:00Z'), TIME_ZONE), '2026-10-05T13:00');
  });
}

// --- run ------------------------------------------------------------------------------------

const run = async () => {
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn(); // eslint-disable-line no-await-in-loop
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  if (failures.length) {
    console.error(`FAIL - ${failures.length} problem(s):\n`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`OK - forecast: ${tests.length} tests of the model, history, panel groups, accuracy, today's progress and the inverter device`);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
