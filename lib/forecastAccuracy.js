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

// How good the forecast has been in real use, as opposed to in a
// backtest. For each day the app keeps the day-ahead forecast (the last
// "tomorrow" forecast made the day before) and, once the day is over, scores
// it against what was produced.

const { addDays } = require('./localDate');

// Days scored for the figures shown.
const ACCURACY_DAYS = 30;

// Fewer scored days than this and there's nothing to show yet.
const MIN_ACCURACY_DAYS = 7;

// Days of forecasts kept: the scoring window and some spare.
const KEEP_DAYS = 45;

// The day-ahead forecast for a date, from a forecast's day summary and its
// hours ([{ time: 'YYYY-MM-DDTHH:MM', wh }], energy in the hour ending then):
// { p10, p50, p90, hours: [Wh by hour ending, 0–23] }, rounded to Wh.
function dayAheadEntry(date, day, forecastHours) {
  const hours = new Array(24).fill(0);
  for (const { time, wh } of forecastHours) {
    if (time.startsWith(date)) hours[Number(time.slice(11, 13))] += wh;
  }

  return {
    p10: Math.round(day.p10),
    p50: Math.round(day.p50),
    p90: Math.round(day.p90),
    hours: hours.map(Math.round),
  };
}

// The log with the entry for date put in (replacing any earlier one: the
// last forecast made before the day is the day-ahead one) and dates more
// than KEEP_DAYS before it dropped.
function recordDayAhead(log, date, entry) {
  const oldest = addDays(date, -KEEP_DAYS);
  return Object.fromEntries([...Object.entries(log ?? {}), [date, entry]]
    .filter(([d]) => d >= oldest)
    .sort(([a], [b]) => (a < b ? -1 : 1)));
}

// Scores the logged forecasts for the ACCURACY_DAYS up to and including
// endDate against actual production: energy { date: Wh | null } and power
// { date: { hours } | null } (the forecaster's history). Returns
// { days, error, bias, coverage, hourlyError } as fractions, or null with
// fewer than MIN_ACCURACY_DAYS days to score:
//   error       total |P50 - actual| / total actual
//   bias        total (P50 - actual) / total actual: > 0 is over-forecasting
//   coverage    share of days the actual fell within P10–P90 (80% is ideal)
//   hourlyError total |forecast - actual| over the hours / total actual,
//               null when there's no hourly production for those days
function scoreForecasts(log, { energy, power }, { endDate, days = ACCURACY_DAYS }) {
  const startDate = addDays(endDate, -(days - 1));
  const scored = Object.entries(log ?? {})
    .filter(([date]) => date >= startDate && date <= endDate)
    .map(([date, entry]) => ({ date, entry, actualWh: energy?.[date] }))
    .filter(({ actualWh }) => typeof actualWh === 'number' && actualWh > 0);

  if (scored.length < MIN_ACCURACY_DAYS) return null;

  const totalActual = scored.reduce((sum, d) => sum + d.actualWh, 0);
  const absMiss = scored.reduce((sum, d) => sum + Math.abs(d.entry.p50 - d.actualWh), 0);
  const miss = scored.reduce((sum, d) => sum + (d.entry.p50 - d.actualWh), 0);
  const inRange = scored.filter((d) => d.actualWh >= d.entry.p10 && d.actualWh <= d.entry.p90).length;

  let hourlyMiss = 0;
  let hourlyActual = 0;
  for (const { date, entry } of scored) {
    const actualHours = power?.[date]?.hours;
    if (!actualHours || !entry.hours) continue;
    for (let hour = 0; hour < 24; hour++) {
      hourlyMiss += Math.abs((entry.hours[hour] ?? 0) - (actualHours[hour] ?? 0));
      hourlyActual += actualHours[hour] ?? 0;
    }
  }

  return {
    days: scored.length,
    error: absMiss / totalActual,
    bias: miss / totalActual,
    coverage: inRange / scored.length,
    hourlyError: hourlyActual > 0 ? hourlyMiss / hourlyActual : null,
  };
}

// The capability's figure: 100% less the daily error, floored at 0.
function accuracyPercent(score) {
  return score ? Math.max(0, Math.round(100 * (1 - score.error))) : null;
}

module.exports = {
  ACCURACY_DAYS,
  MIN_ACCURACY_DAYS,
  dayAheadEntry,
  recordDayAhead,
  scoreForecasts,
  accuracyPercent,
};
