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

test('forecaster fetches history in blocks and reuses complete ones the next day', async () => {
  const api = fakeSolarEdge();
  const forecaster = new SolarForecaster({ solarEdgeApi: api, siteId: 1, timeZone: 'Australia/Melbourne' });
  await forecaster.init();

  const energy = await forecaster.getEnergy({ startDate: '2025-10-04', endDate: '2026-10-03' });
  assert.equal(energy.length, 365);
  assert.equal(energy[0].date, '2025-10-04');
  assert.equal(energy[364].date, '2026-10-03');
  assert.equal(api.calls.filter((c) => c.startsWith('energy')).length, 13);

  const capW = await forecaster.getCapW({ endDate: '2026-10-03' });
  assert.equal(capW, 4000 * SolarForecaster.CAP_HEADROOM);
  const powerCalls = api.calls.filter((c) => c.startsWith('power')).length;
  assert.ok(powerCalls <= 5);

  // The next day only the current month and week are fetched again.
  api.calls.length = 0;
  await forecaster.getEnergy({ startDate: '2025-10-05', endDate: '2026-10-04' });
  await forecaster.getCapW({ endDate: '2026-10-04' });
  assert.deepEqual(api.calls, ['energy 2026-10-01..2026-10-04', 'power 2026-10-01..2026-10-04']);
});

test('concurrent requests for the same history share in-flight blocks', async () => {
  const api = fakeSolarEdge();
  const forecaster = new SolarForecaster({ solarEdgeApi: api, siteId: 1, timeZone: 'Australia/Melbourne' });

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

  const forecaster = new SolarForecaster({ solarEdgeApi: api, siteId: 1, timeZone: 'Australia/Melbourne' });
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
