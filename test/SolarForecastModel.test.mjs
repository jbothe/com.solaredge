import assert from 'node:assert/strict';
import { test } from 'node:test';

import OpenMeteoAPI from '../lib/OpenMeteoAPI.mjs';
import SolarForecaster from '../lib/SolarForecaster.mjs';
import {
  DEFAULT_FACTOR,
  addDays,
  applyBands,
  buildSeasonalProfile,
  buildShadingProfile,
  cloudBin,
  dayOfYear,
  daysBetween,
  fitBands,
  fitCeiling,
  fitFactor,
  idealHourlyWh,
  localDate,
  localDateTime,
  predictDayWh,
  seasonalMultiplier,
  shadingMultipliers,
  summariseDays,
} from '../lib/SolarForecastModel.mjs';

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
  assert.equal(OpenMeteoAPI.toOpenMeteoAzimuth(180), 0);
  assert.equal(OpenMeteoAPI.toOpenMeteoAzimuth(90), -90);
  assert.equal(OpenMeteoAPI.toOpenMeteoAzimuth(270), 90);
  assert.equal(OpenMeteoAPI.toOpenMeteoAzimuth(0), -180);
});

test('clipping caps each hour, not the day', () => {
  assert.equal(predictDayWh([1000, 6000, 1000], 1, 5000), 7000);
});

function syntheticDays(factor, count, { capW = Infinity, noise = () => 1 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const idealHours = [0, 500, 2500, 5000, 6000, 5000, 2500, 500, 0].map((wh) => wh * (0.5 + (i % 5) / 8));
    return {
      date: addDays('2026-08-01', i),
      idealHours,
      actualWh: predictDayWh(idealHours, factor, capW) * noise(i),
    };
  });
}

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
function shadedYear(shade) {
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
}

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
