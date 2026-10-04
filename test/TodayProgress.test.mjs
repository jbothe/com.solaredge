import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MIN_EXPECTED_WH, energyAfter, energyBefore, todayProgress,
} from '../lib/TodayProgress.mjs';

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
