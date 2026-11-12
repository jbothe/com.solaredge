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

// How today is going against the forecast, through the day.
//
// Hours are energy (Wh) by the hour they end in, 0–23, as the forecast and
// the history store them: hours[11] is 10:00–11:00.

// Below this much expected so far, the comparison is all noise (dawn), so
// there's no figure.
const MIN_EXPECTED_WH = 1000;

// Energy the hours put before the given local time ({ hour, minute }): the
// hours already over, and the part of the current one that has passed.
function energyBefore(hours, { hour, minute }) {
  let wh = 0;
  for (let h = 0; h <= hour; h++) wh += hours[h] ?? 0;
  if (hour + 1 < 24) wh += (hours[hour + 1] ?? 0) * (minute / 60);
  return wh;
}

// Energy the hours put after the given local time.
function energyAfter(hours, at) {
  const total = hours.reduce((sum, wh) => sum + (wh ?? 0), 0);
  return total - energyBefore(hours, at);
}

// { expectedWh, vsForecast, remainingWh, projectedWh }:
//   expectedWh   what planHours (the day-ahead forecast) put before now
//   vsForecast   producedWh / expectedWh, null until MIN_EXPECTED_WH is
//                expected
//   remainingWh  what latestHours (the latest forecast) put after now
//   projectedWh  producedWh + remainingWh: where today should end
// planHours may be null (no forecast kept for today); latestHours null gives
// no remaining or projected figures.
function todayProgress({
  planHours, latestHours, producedWh, at,
}) {
  const expectedWh = planHours ? energyBefore(planHours, at) : null;
  const vsForecast = expectedWh >= MIN_EXPECTED_WH && typeof producedWh === 'number'
    ? producedWh / expectedWh
    : null;

  const remainingWh = latestHours ? Math.max(0, energyAfter(latestHours, at)) : null;
  const projectedWh = remainingWh !== null && typeof producedWh === 'number' ? producedWh + remainingWh : null;

  return {
    expectedWh, vsForecast, remainingWh, projectedWh,
  };
}

module.exports = {
  MIN_EXPECTED_WH,
  energyBefore,
  energyAfter,
  todayProgress,
};
