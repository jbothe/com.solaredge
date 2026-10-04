import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describePlanes, parsePlanes, planesFromGroups } from '../lib/PanelLayout.mjs';
import SolarForecaster from '../lib/SolarForecaster.mjs';

const unused = { panels: 0, tilt: 20, azimuth: null };

test('one group needs no panel count and takes the whole array', () => {
  assert.deepEqual(planesFromGroups([{ panels: 0, tilt: 25, azimuth: 315 }, unused, unused]), [
    { tilt: 25, azimuth: 315, share: 1 },
  ]);
});

test('groups are weighted by their panels, and empty ones dropped', () => {
  // The author's site, by compass: 13 panels facing 306°, 9 facing 33°.
  const planes = planesFromGroups([
    { panels: 13, tilt: 20, azimuth: 306 },
    { panels: 9, tilt: 20, azimuth: 33 },
    unused,
  ]);
  assert.deepEqual(planes.map((p) => [p.panels, p.azimuth]), [[13, 306], [9, 33]]);
  assert.ok(Math.abs(planes[0].share - 13 / 22) < 1e-12);
  assert.equal(describePlanes(planes), '13 × 20°/306°, 9 × 20°/33°');
});

test('a second group without a count for the first is refused with a reason', () => {
  assert.throws(
    () => planesFromGroups([{ panels: 0, tilt: 20, azimuth: 306 }, { panels: 9, tilt: 20, azimuth: 33 }, unused]),
    /how many panels the first group has/,
  );
});

test('planes parse from the harness option', () => {
  const planes = parsePlanes('13@20/306, 9@20/33');
  assert.deepEqual(planes.map((p) => p.share), [13 / 22, 9 / 22]);
  assert.throws(() => parsePlanes('north'), /panels@tilt\/azimuth/);
});

const site = {
  async getSiteDetails() {
    return { peakPower: 5.72, latitude: -37.81, longitude: 144.96 };
  },
};

test('a plane left facing "the equator" faces north in the southern hemisphere', async () => {
  const forecaster = new SolarForecaster({
    solarEdgeApi: site, siteId: 1, timeZone: 'Australia/Melbourne', planes: planesFromGroups([{ panels: 0, tilt: 20, azimuth: null }, unused, unused]),
  });
  await forecaster.init();
  assert.deepEqual(forecaster.location.planes, [{ tilt: 20, azimuth: 0, share: 1 }]);
  assert.equal(describePlanes(forecaster.location.planes), '100% × 20°/0°');
});

test('irradiance is blended across planes by their share', async () => {
  // A fake Open-Meteo where a plane's irradiance is its azimuth, so the blend
  // is easy to check.
  const openMeteoApi = {
    async getForecast({ azimuth }) {
      return [{
        time: '2026-10-05T12:00', gti: azimuth, temperature: 15, cloudCover: 10,
      }];
    },
  };
  const forecaster = new SolarForecaster({
    solarEdgeApi: site, openMeteoApi, siteId: 1, timeZone: 'Australia/Melbourne', planes: parsePlanes('3@20/300,1@20/100'),
  });
  await forecaster.init();

  const [hour] = await forecaster.getHours('getForecast', { forecastDays: 2 });
  assert.equal(hour.gti, 300 * 0.75 + 100 * 0.25);
  assert.equal(hour.cloudCover, 10);
});
