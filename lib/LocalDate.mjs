// Dates as local 'YYYY-MM-DD' strings in a site's time zone. Arithmetic is
// done at UTC noon so DST changes can't shift the day.

export function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// 'YYYY-MM-DDTHH:MM', the same shape as Open-Meteo's local timestamps.
export function localDateTime(date, timeZone) {
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

export function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromDateString, toDateString) {
  return Math.round((Date.parse(`${toDateString}T12:00:00Z`) - Date.parse(`${fromDateString}T12:00:00Z`)) / 86400000);
}
