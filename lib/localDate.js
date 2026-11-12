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

// Dates as local 'YYYY-MM-DD' strings in a site's time zone. Arithmetic is
// done at UTC noon so DST changes can't shift the day.

const { dateIn } = require('./deviceHelpers');

/** `date` (a Date) in `timeZone` as 'YYYY-MM-DD'. */
const localDate = dateIn;

// 'YYYY-MM-DDTHH:MM', the same shape as Open-Meteo's local timestamps.
function localDateTime(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, value]));

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromDateString, toDateString) {
  return Math.round((Date.parse(`${toDateString}T12:00:00Z`) - Date.parse(`${fromDateString}T12:00:00Z`)) / 86400000);
}

module.exports = {
  localDate,
  localDateTime,
  addDays,
  daysBetween,
};
