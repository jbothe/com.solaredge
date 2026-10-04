import assert from 'node:assert/strict';
import { test } from 'node:test';

import SolarForecaster from '../lib/SolarForecaster.mjs';
import { addDays, alignedBlocks, daysBetween } from '../lib/SolarForecastModel.mjs';

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

// A stand-in for SolarEdgeAPI that records calls and returns one value per day
// (energy) or per 15 minutes (power), shaped like the dashboard endpoints.
function fakeSolarEdge() {
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
    async getSiteEnergy({ startDate, endDate }) {
      calls.push(`energy ${startDate}..${endDate}`);
      assert.ok(daysBetween(startDate, endDate) < 93, 'energy request over 93 days');
      return {
        chart: {
          measurements: days(startDate, endDate).map((d) => ({ measurementTime: `${d}T00:00:00+10:00`, production: 10000 })),
        },
      };
    },
    async getSitePower({ startDate, endDate }) {
      calls.push(`power ${startDate}..${endDate}`);
      assert.ok(daysBetween(startDate, endDate) < 8, 'power request over 8 days');
      return {
        measurements: days(startDate, endDate).map((d) => ({ measurementTime: `${d}T12:00:00+10:00`, production: d === '2026-09-20' ? 4000 : 2000 })),
      };
    },
  };
}

// Noon in Melbourne on the given date, as the forecaster's clock.
const at = (date) => () => new Date(`${date}T02:00:00Z`);

// An in-memory stand-in for the device store.
function memoryStore() {
  const store = { saved: null, saves: 0 };
  store.load = async () => (store.saved ? JSON.parse(JSON.stringify(store.saved)) : null);
  store.save = async (history) => {
    store.saved = JSON.parse(JSON.stringify(history));
    store.saves += 1;
  };
  return store;
}

function forecasterFor(api, options = {}) {
  return new SolarForecaster({
    solarEdgeApi: api, siteId: 1, timeZone: 'Australia/Melbourne', now: at('2026-10-04'), ...options,
  });
}

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
  const { getSiteEnergy } = api;
  // SolarEdge has nothing for 2026-08-10 or 2026-10-02.
  api.getSiteEnergy = async (args) => {
    const result = await getSiteEnergy(args);
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
  const { getSiteEnergy } = api;
  let failures = 1;
  api.getSiteEnergy = async (args) => {
    if (args.startDate === '2026-09-01' && failures-- > 0) throw new Error('boom');
    return getSiteEnergy(args);
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
  const openMeteoApi = { getForecast: async () => hours };
  const forecaster = forecasterFor(fakeSolarEdge(), { openMeteoApi });
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
