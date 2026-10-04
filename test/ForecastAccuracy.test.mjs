import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MIN_ACCURACY_DAYS, accuracyPercent, dayAheadEntry, recordDayAhead, scoreForecasts,
} from '../lib/ForecastAccuracy.mjs';
import { addDays } from '../lib/LocalDate.mjs';

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
function tenDays() {
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
}

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
