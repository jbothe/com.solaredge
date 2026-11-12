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

// Open-Meteo is free without a key for non-commercial use (< 10k calls/day).
// Radiation values are the mean over the *preceding* hour, so the hourly
// value labelled 10:00 is the energy that arrives between 09:00 and 10:00.
class OpenMeteoClient {

  static REQUEST_TIMEOUT = 30 * 1000;

  static HOURLY = ['global_tilted_irradiance', 'temperature_2m', 'cloud_cover'];

  /** @param {object} [args] @param {Function} [args.log] */
  constructor({ log } = {}) {
    this.log = log || (() => {});
  }

  async request(url) {
    const start = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(OpenMeteoClient.REQUEST_TIMEOUT) });
      const body = await res.text();
      this.log(`[OpenMeteo] GET ${url} -> ${res.status} (${Date.now() - start}ms, ${Buffer.byteLength(body)}B)`);

      const json = JSON.parse(body);
      if (!res.ok || json.error) throw new Error(json.reason ?? res.statusText ?? 'Open-Meteo request failed');
      return json;
    } catch (error) {
      if (error.name === 'TimeoutError') {
        throw new Error(`Open-Meteo request timed out after ${OpenMeteoClient.REQUEST_TIMEOUT}ms`);
      }
      // fetch's 'fetch failed' carries the reason (e.g. ENOTFOUND) in its cause
      const code = error.code || error.cause?.code;
      if (code && !error.message.includes(code)) error.message = `${error.message} [${code}]`;
      this.log(`[OpenMeteo] GET ${url} -> failed (${Date.now() - start}ms, ${error.message})`);
      throw error;
    }
  }

  // Open-Meteo measures azimuth from south (0 = S, -90 = E, 90 = W, ±180 = N),
  // the rest of the app uses compass degrees (0 = N, 90 = E, 180 = S).
  static toOpenMeteoAzimuth(compass) {
    return ((compass - 180 + 540) % 360) - 180;
  }

  buildUrl(base, {
    latitude, longitude, tilt, azimuth, timeZone, hourly, ...rest
  }) {
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      tilt: String(tilt),
      azimuth: String(OpenMeteoClient.toOpenMeteoAzimuth(azimuth)),
      timezone: timeZone,
      hourly: hourly.join(','),
      ...rest,
    });
    return `${base}?${params}`;
  }

  // Latest forecast, today and the next (forecastDays - 1) days.
  // Returns [{ time: 'YYYY-MM-DDTHH:MM', gti, temperature }] in local time.
  async getForecast({
    latitude, longitude, tilt, azimuth, timeZone, forecastDays = 2,
  }) {
    const json = await this.request(this.buildUrl('https://api.open-meteo.com/v1/forecast', {
      latitude,
      longitude,
      tilt,
      azimuth,
      timeZone,
      hourly: OpenMeteoClient.HOURLY,
      forecast_days: String(forecastDays),
    }));

    return OpenMeteoClient.toHours(json.hourly, '');
  }

  // What the forecast *issued the day before* said for each hour in the
  // range. Calibrating against these, rather than against what the weather
  // turned out to be, makes the fitted factor match how it is used: to
  // predict tomorrow.
  async getDayAheadHistory({
    latitude, longitude, tilt, azimuth, timeZone, startDate, endDate,
  }) {
    const suffix = '_previous_day1';
    const json = await this.request(this.buildUrl('https://previous-runs-api.open-meteo.com/v1/forecast', {
      latitude,
      longitude,
      tilt,
      azimuth,
      timeZone,
      hourly: OpenMeteoClient.HOURLY.map((name) => `${name}${suffix}`),
      start_date: startDate,
      end_date: endDate,
    }));

    return OpenMeteoClient.toHours(json.hourly, suffix);
  }

  // The archived forecasts, stitched together from the first hours of each
  // run: close to what actually happened. Used to learn how the array
  // behaves through the year, separately from how good the forecast was.
  async getHistoricalForecast({
    latitude, longitude, tilt, azimuth, timeZone, startDate, endDate,
  }) {
    const json = await this.request(this.buildUrl('https://historical-forecast-api.open-meteo.com/v1/forecast', {
      latitude,
      longitude,
      tilt,
      azimuth,
      timeZone,
      hourly: OpenMeteoClient.HOURLY,
      start_date: startDate,
      end_date: endDate,
    }));

    return OpenMeteoClient.toHours(json.hourly, '');
  }

  static toHours(hourly, suffix) {
    const gti = hourly[`global_tilted_irradiance${suffix}`];
    const temperature = hourly[`temperature_2m${suffix}`];
    const cloudCover = hourly[`cloud_cover${suffix}`];

    return hourly.time.map((time, i) => ({
      time,
      gti: gti[i],
      temperature: temperature[i],
      cloudCover: cloudCover[i],
    }));
  }

}

module.exports = OpenMeteoClient;
