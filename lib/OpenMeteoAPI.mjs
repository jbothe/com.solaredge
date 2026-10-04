import fetch from 'node-fetch';

// Open-Meteo is free without a key for non-commercial use (< 10k calls/day).
// Radiation values are the mean over the *preceding* hour, so the hourly
// value labelled 10:00 is the energy that arrives between 09:00 and 10:00.
export default class OpenMeteoAPI {

  static REQUEST_TIMEOUT = 1000 * 30; // 30 seconds

  static HOURLY = ['global_tilted_irradiance', 'temperature_2m', 'cloud_cover'];

  async request(url) {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OpenMeteoAPI.REQUEST_TIMEOUT);

    try {
      const res = await fetch(url, { signal: controller.signal });
      const body = await res.text();

      console.log(`[OpenMeteoAPI] GET ${url} -> ${res.status} (${Date.now() - start}ms, ${Buffer.byteLength(body)}B)`);

      const json = JSON.parse(body);
      if (!res.ok || json.error) {
        throw new Error(json.reason ?? res.statusText ?? 'Open-Meteo request failed');
      }

      return json;
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log(`[OpenMeteoAPI] GET ${url} -> timed out (${Date.now() - start}ms)`);
        throw new Error(`Open-Meteo request timed out after ${OpenMeteoAPI.REQUEST_TIMEOUT}ms`);
      }

      // A connection that fails over both IPv6 and IPv4 surfaces as an
      // AggregateError with an empty message; the code is the useful part.
      const reason = [err.message, err.code && `[${err.code}]`].filter(Boolean).join(' ') || err.name;
      console.log(`[OpenMeteoAPI] GET ${url} -> failed (${Date.now() - start}ms, ${reason})`);

      if (err.code && !err.message.includes(err.code)) {
        err.message = `${err.message} [${err.code}]`;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
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
      azimuth: String(OpenMeteoAPI.toOpenMeteoAzimuth(azimuth)),
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
      hourly: OpenMeteoAPI.HOURLY,
      forecast_days: String(forecastDays),
    }));

    return OpenMeteoAPI.toHours(json.hourly, '');
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
      hourly: OpenMeteoAPI.HOURLY.map((name) => `${name}${suffix}`),
      start_date: startDate,
      end_date: endDate,
    }));

    return OpenMeteoAPI.toHours(json.hourly, suffix);
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
      hourly: OpenMeteoAPI.HOURLY,
      start_date: startDate,
      end_date: endDate,
    }));

    return OpenMeteoAPI.toHours(json.hourly, '');
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
