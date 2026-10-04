/* eslint-disable no-console */
// Proof of concept: replacing every V1 Monitoring API call with endpoints of
// the internal monitoring.solaredge.com API the app already logs in to.
// See docs/solaredge-v2-migration.md.
//
//   npm run internal                  call each replacement endpoint and print what it gives
//
// Configuration comes from .env (gitignored):
//   SOLAREDGE_USERNAME / SOLAREDGE_PASSWORD   required (the app's own cookie login)
//   SOLAREDGE_SITE_ID                         required
//
// Raw responses go to .cache/internal-probe (gitignored).

import fs from 'node:fs/promises';
import path from 'node:path';

import SolarEdgeAPI from '../lib/SolarEdgeAPI.mjs';

const BASE = 'https://monitoring.solaredge.com/services/dashboard';
const CACHE_DIR = path.resolve('.cache/internal-probe');

class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message);
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const localDay = (date, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);

const kwh = (wh) => (typeof wh === 'number' ? `${(wh / 1000).toFixed(2)} kWh` : '-');

async function main() {
  const { SOLAREDGE_USERNAME: username, SOLAREDGE_PASSWORD: password, SOLAREDGE_SITE_ID: siteId } = process.env;
  if (!username || !password || !siteId) {
    fail('Set SOLAREDGE_USERNAME, SOLAREDGE_PASSWORD and SOLAREDGE_SITE_ID in .env.');
  }

  const api = new SolarEdgeAPI();
  await api.login({ username, password });
  await fs.mkdir(CACHE_DIR, { recursive: true });

  // Query values may be arrays: `measurement-types` is repeated, not comma-joined.
  const get = async (name, pathname, query = {}) => {
    const url = new URL(`${BASE}${pathname}`);
    for (const [k, v] of Object.entries(query)) {
      for (const item of [v].flat()) url.searchParams.append(k, item);
    }

    const res = await api.request(url.toString(), {
      headers: { ...api.headers, Cookie: api.cookies.join('; '), Accept: 'application/json' },
    });
    const body = await res.json().catch(() => null);
    await fs.writeFile(path.join(CACHE_DIR, `${name}.json`), JSON.stringify(body, null, 2));

    if (!res.ok) fail(`${name}: ${res.status} ${JSON.stringify(body)}`);
    return body;
  };

  // Site details → replaces V1 /site/{id}/details (forecaster: peak power, location).
  const details = await get('site-details', `/site-details/${siteId}/details`);
  console.log(`\nSite details: peakPower=${details.peakPower} kWp, lat/lon=${details.latitude},${details.longitude}, installed=${details.installationDate}`);

  // The time zone is not in site-details; the cni site record has it.
  const cniRes = await api.request(`https://monitoring.solaredge.com/services/cni/ui-api/sites/${siteId}`, {
    headers: { ...api.headers, Cookie: api.cookies.join('; '), Accept: 'application/json' },
  });
  const { timezone: timeZone } = await cniRes.json();
  console.log(`Time zone: ${timeZone}`);

  const today = localDay(new Date(), timeZone);
  const yesterday = addDays(today, -1);
  const installDay = details.installationDate.slice(0, 10);

  // Equipment → replaces V1 /equipment/{id}/list (inverter serial), adds battery capacity.
  const equipment = await get('equipment', `/v2/site-details/${siteId}/equipment`);
  console.log(`Inverters: ${equipment.inverters?.details?.map((d) => `${d.modelName} ${d.serialNumbers.join(',')}`).join('; ')}`);
  console.log(`Storage:   ${equipment.storage?.details?.map((d) => `${d.manufacturer} ${d.serialNumber} ${d.capacity} kWh`).join('; ') ?? 'none'}`);

  // Daily energy → replaces V1 /site/{id}/energy?timeUnit=DAY. At most 31 days per call
  // (a longer range is rejected with BAD_ARGUMENTS "DAYS"). Battery-corrected PV.
  const energy = await get('energy-days', `/energy/sites/${siteId}`, {
    'start-date': addDays(today, -30),
    'end-date': yesterday,
    'chart-time-unit': 'days',
    'measurement-types': ['production', 'production-distribution-with-storage'],
  });
  const days = energy.chart?.measurements ?? [];
  console.log(`\nDaily production, ${days.length} days (PV, split by destination):`);
  for (const m of days.slice(-5)) {
    const pd = m.productionDistribution ?? {};
    console.log(`  ${m.measurementTime.slice(0, 10)}  ${kwh(m.production)}  (home ${kwh(pd.productionToHome)}, battery ${kwh(pd.productionToBattery)}, grid ${kwh(pd.productionToGrid)})`);
  }

  // 15-min power → replaces V1 /site/{id}/power for the clipping cap. Up to 7
  // days per call. True PV: zero at night even while the battery discharges,
  // unlike V1, which counts battery discharge as production.
  const power = await get('power-quarter-hours', `/power/sites/${siteId}`, {
    'start-date': addDays(today, -7),
    'end-date': yesterday,
    'chart-time-unit': 'quarter-hours',
    'measurement-types': 'production',
  });
  const watts = (power.measurements ?? []).map((m) => m.production).filter((v) => typeof v === 'number');
  console.log(`\n15-min PV power, last 7 days: ${watts.length} samples, max ${Math.max(...watts).toFixed(0)} W`);

  // Battery lifetime totals → replaces V1 storageData lifeTimeEnergyCharged/Discharged.
  const storage = await get('storage-distribution-lifetime', `/storage/energy/distribution/sites/${siteId}`, {
    'start-date': installDay,
    'end-date': today,
  });
  console.log(`\nBattery lifetime: charged ${kwh(storage.sources?.total)} (PV ${kwh(storage.sources?.pv)}, grid ${kwh(storage.sources?.grid)}), discharged ${kwh(storage.destinations?.total)}`);

  // Battery SoC history (15-min, max 1 day per call). No SoH or temperature here.
  const battery = await get('battery-soc', `/battery/sites/${siteId}`, { 'start-date': yesterday, 'end-date': today });
  // Slots later than now come back as null.
  const soc = (battery.measurements ?? []).filter((m) => typeof m.stateOfCharge === 'number');
  console.log(`Battery SoC: ${soc.length} samples, latest ${soc[soc.length - 1]?.stateOfCharge}%`);

  // Lifetime grid import/export and production, by year.
  const totals = await get('energy-lifetime', `/energy/sites/${siteId}`, {
    'start-date': installDay,
    'end-date': today,
    'chart-time-unit': 'years',
    'measurement-types': ['production', 'import', 'export'],
  });
  console.log(`Lifetime: production ${kwh(totals.summary?.production)}, import ${kwh(totals.summary?.import)}, export ${kwh(totals.summary?.export)}`);

  console.log('\nNot available to a homeowner login: inverter temperature, AC/DC voltage (charts API is installer-only), battery temperature and state of health.');
  console.log('Raw responses in .cache/internal-probe/.');
}

main().catch((err) => {
  console.error(err instanceof UsageError ? err.message : err);
  process.exitCode = 1;
});
