/* eslint-disable no-console */
// Proof of concept for the SolarEdge V2 Monitoring API with Site Access
// OAuth, ahead of the V1 sunset on 2026-11-03. See docs/solaredge-v2-migration.md.
//
//   npm run v2 -- auth        run the OAuth flow (localhost:8080 callback), save tokens
//   npm run v2 -- auth --extra scope,state
//                             same, adding optional authorize params (see OPTIONAL_PARAMS)
//   npm run v2 -- auth --code CODE [--site SITE_ID]
//                             exchange a code copied from the address bar by hand,
//                             if the redirect to localhost didn't land
//   npm run v2 -- refresh     refresh the token pair (they rotate on every refresh)
//   npm run v2 -- probe       call each V2 endpoint the app would use (~11 credits)
//   npm run v2 -- compare     V2 vs V1 daily energy, last 60 days (~4 V2 credits, 1 V1 call)
//
// Configuration comes from .env (gitignored):
//   SOLAREDGE_CLIENT_ID / SOLAREDGE_CLIENT_SECRET   required
//   SOLAREDGE_SITE_ID                               optional, else the site_id from the callback
//   SOLAREDGE_API_KEY                               V1 key, only for `compare`
//
// Tokens and raw responses go to .cache/solaredge-v2 (gitignored).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';

const AUTHORIZE_URL = 'https://connect.solaredge.com/authorize';
const TOKEN_URL = 'https://monitoringapi.solaredge.com/v2/oauth2/token';
const API_BASE = 'https://monitoringapi.solaredge.com/v2';
const V1_BASE = 'https://monitoringapi.solaredge.com';

const PORT = 8080;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const SCOPES = 'SITE_DATA DEVICE_DATA';
const ACCESS_DURATION_MONTHS = 24;

const CACHE_DIR = path.resolve('.cache/solaredge-v2');
const TOKEN_FILE = path.join(CACHE_DIR, 'token.json');
const RESPONSES_DIR = path.join(CACHE_DIR, 'responses');

// Refresh this long before the access token's stated expiry.
const REFRESH_MARGIN = 1000 * 60 * 5;

class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message);
}

function credentials() {
  const clientId = process.env.SOLAREDGE_CLIENT_ID;
  const clientSecret = process.env.SOLAREDGE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    fail('Set SOLAREDGE_CLIENT_ID and SOLAREDGE_CLIENT_SECRET in .env.');
  }
  return { clientId, clientSecret };
}

const mask = (value) => (typeof value === 'string' && value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)` : '***');

// ---------------------------------------------------------------- tokens

async function loadToken() {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function saveToken(token) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok || !json?.access_token) {
    fail(`Token endpoint returned ${res.status}: ${text}`);
  }

  return { json, headers: res.headers };
}

function describeToken(json) {
  const extra = Object.keys(json).filter((k) => !['access_token', 'refresh_token', 'token_type', 'expires_in'].includes(k));
  console.log(`  token_type:    ${json.token_type}`);
  console.log(`  expires_in:    ${json.expires_in}s`);
  console.log(`  access_token:  ${mask(json.access_token)}`);
  console.log(`  refresh_token: ${mask(json.refresh_token)}`);
  if (extra.length) {
    console.log(`  other fields:  ${extra.map((k) => `${k}=${JSON.stringify(json[k])}`).join(', ')}`);
  }
}

async function exchangeCode({ code, siteId, callbackParams }) {
  const { clientId, clientSecret } = credentials();
  const { json } = await postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
  });

  // Saved before anything else: the code is single-use.
  await saveToken({
    ...json,
    obtained_at: Date.now(),
    site_id: siteId ?? null,
    callback_params: callbackParams ?? null,
  });

  console.log('\nToken exchange OK, saved to .cache/solaredge-v2/token.json');
  describeToken(json);
}

async function refreshToken(token) {
  const { clientId, clientSecret } = credentials();
  const { json } = await postToken({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });

  // Refresh tokens rotate and the old one is now dead, so persist the new
  // pair before doing anything that could fail.
  const next = {
    ...token,
    ...json,
    obtained_at: Date.now(),
    refresh_count: (token.refresh_count ?? 0) + 1,
  };
  await saveToken(next);

  console.log(`Refreshed token (refresh #${next.refresh_count}); refresh token rotated: ${json.refresh_token !== token.refresh_token}`);
  describeToken(json);
  return next;
}

async function validToken() {
  let token = await loadToken();
  if (!token) fail('No token yet. Run `npm run v2 -- auth` first.');

  const expiresAt = token.obtained_at + (token.expires_in ?? 0) * 1000;
  if (Date.now() > expiresAt - REFRESH_MARGIN) {
    token = await refreshToken(token);
  }
  return token;
}

// ---------------------------------------------------------------- auth

// SolarEdge Connect answers "Configuration Error 400.4" when the homeowner
// guide's full parameter set is sent, but works with client_id alone (the
// form the Authentication page documents). `extra` adds parameters back one
// at a time to find the culprit.
const OPTIONAL_PARAMS = {
  scope: () => SCOPES,
  redirect_uri: () => REDIRECT_URI,
  state: (state) => state,
  access_duration: () => String(ACCESS_DURATION_MONTHS),
};

function authorizeUrl(state, extra = []) {
  const { clientId } = credentials();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  for (const name of extra) {
    if (!OPTIONAL_PARAMS[name]) fail(`Unknown --extra "${name}"; use ${Object.keys(OPTIONAL_PARAMS).join(', ')}.`);
    url.searchParams.set(name, OPTIONAL_PARAMS[name](state));
  }
  return url.toString();
}

function waitForCallback(state, extra) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404).end();
        return;
      }

      const params = Object.fromEntries(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(params.code
        ? '<h1>SolarEdge authorization received</h1><p>You can close this tab and go back to the terminal.</p>'
        : `<h1>No code in callback</h1><pre>${JSON.stringify(params, null, 2).replace(/</g, '&lt;')}</pre>`);

      server.close();

      if (!params.code) {
        reject(new Error(`Callback had no code: ${JSON.stringify(params)}`));
        return;
      }
      resolve(params);
    });

    server.on('error', reject);
    server.listen(PORT, () => {
      console.log(`Listening on ${REDIRECT_URI}\n`);
      console.log('Open this URL and sign in with your SolarEdge homeowner (mySolarEdge) login:\n');
      console.log(`  ${authorizeUrl(state, extra)}\n`);
    });
  });
}

async function auth({ code, site, extra }) {
  if (code) {
    await exchangeCode({ code, siteId: site ?? process.env.SOLAREDGE_SITE_ID });
    return;
  }

  const state = crypto.randomBytes(12).toString('hex');
  const params = await waitForCallback(state, extra ? extra.split(',') : []);

  const { code: receivedCode, ...rest } = params;
  console.log('Callback received with params:');
  console.log(`  code: ${mask(receivedCode)}`);
  for (const [k, v] of Object.entries(rest)) console.log(`  ${k}: ${v}`);
  if (params.state !== undefined) console.log(`  state matches: ${params.state === state}`);

  await exchangeCode({
    code: receivedCode,
    siteId: params.site_id ?? process.env.SOLAREDGE_SITE_ID,
    callbackParams: rest,
  });
}

// ---------------------------------------------------------------- API calls

let callCount = 0;

// 'YYYY-MM-DDTHH:MM:SS' wall-clock time in the given zone.
function localIso(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

// The Free tier allows 10 calls per clock minute, and rejected calls count.
const CALLS_PER_MINUTE = 9;
const callTimes = [];

async function throttle() {
  for (;;) {
    const now = Date.now();
    while (callTimes.length && now - callTimes[0] >= 60 * 1000) callTimes.shift();
    if (callTimes.length < CALLS_PER_MINUTE) break;
    const wait = 60 * 1000 - (now - callTimes[0]) + 500;
    console.log(`  (pausing ${Math.ceil(wait / 1000)}s for the per-minute limit)`);
    await new Promise((resolve) => setTimeout(resolve, wait)); // eslint-disable-line homey-app/global-timers
  }
  callTimes.push(Date.now());
}

// Set once site details are known; `from`/`to` are written in site-local time.
let siteTimeZone = null;

// Despite the docs' examples, `from`/`to` must be Instants: a bare local
// datetime is rejected with "Failed to convert ... to required type [Instant]".
function zonedToInstant(local, timeZone) {
  const guess = Date.parse(`${local}Z`);
  const offset = Date.parse(`${localIso(new Date(guess), timeZone)}Z`) - guess;
  return new Date(guess - offset).toISOString().replace('.000Z', 'Z');
}

async function api(token, endpoint, query = {}, { method = 'GET', save } = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    const isLocal = ['from', 'to'].includes(k) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(v);
    url.searchParams.set(k, isLocal && siteTimeZone ? zonedToInstant(v, siteTimeZone) : v);
  }

  await throttle();
  const start = Date.now();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
  });
  callCount += 1;

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  const rate = ['x-ratelimit-remaining-minute', 'x-ratelimit-limit-minute', 'retry-after']
    .filter((h) => res.headers.has(h))
    .map((h) => `${h.replace('x-ratelimit-', '')}=${res.headers.get(h)}`)
    .join(' ');

  console.log(`\n${method} ${url.pathname}${url.search} -> ${res.status} (${Date.now() - start}ms, ${text.length}B) ${rate}`);

  if (save) {
    await fs.mkdir(RESPONSES_DIR, { recursive: true });
    await fs.writeFile(path.join(RESPONSES_DIR, `${save}.json`), JSON.stringify({
      request: `${method} ${url.pathname}${url.search}`,
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body,
    }, null, 2));
  }

  if (!res.ok) {
    console.log(`  error: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`);
  }

  return {
    status: res.status, ok: res.ok, body, headers: res.headers,
  };
}

const localDay = (date, timeZone) => localIso(date, timeZone).slice(0, 10);

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function lastValue(series) {
  const values = series?.values ?? [];
  return values.length ? values[values.length - 1] : null;
}

function siteIdOf(token) {
  const siteId = process.env.SOLAREDGE_SITE_ID || token.site_id;
  if (!siteId) fail('No site ID: set SOLAREDGE_SITE_ID in .env (the callback did not provide one).');
  return siteId;
}

async function siteDetails(token, siteId) {
  const { ok, body } = await api(token, `/sites/${siteId}`, {}, { save: 'site-details' });
  if (!ok) fail('Site details failed; cannot continue.');
  siteTimeZone = body.location?.timezone ?? body.location?.timeZone ?? null;
  return body;
}

// ---------------------------------------------------------------- probe

async function probe() {
  const token = await validToken();
  const siteId = siteIdOf(token);
  const now = new Date();

  // 1. Site details: replaces V1 /site/{id}/details for the forecaster.
  const site = await siteDetails(token, siteId);
  const timeZone = site.location?.timezone ?? site.location?.timeZone;
  console.log(`  name=${site.name} peakPower=${site.peakPower} installed=${site.installationDate} tz=${timeZone}`);
  console.log(`  lat/lon=${site.location?.latitude},${site.location?.longitude} status=${site.activationStatus}`);
  if (!timeZone) fail('Site details had no time zone.');

  const today = localDay(now, timeZone);
  const yesterday = addDays(today, -1);
  const oneHourAgo = localIso(new Date(now.getTime() - 60 * 60 * 1000), timeZone);
  const nowLocal = localIso(now, timeZone);
  const installDay = (site.installationDate ?? '2010-01-01').slice(0, 10);

  // 2. Inventory: inverter serial (V1 /equipment/list) and battery nameplate.
  // `types` is an array parameter; try the comma form and see what comes back.
  const devices = await api(token, `/sites/${siteId}/devices`, { types: 'INVERTER,BATTERY,METER' }, { save: 'devices' });
  const deviceList = Array.isArray(devices.body) ? devices.body : devices.body?.devices ?? [];
  for (const d of deviceList) {
    console.log(`  ${d.type} sn=${d.serialNumber} model=${d.model} nameplate=${d.nameplate ?? '-'} active=${d.active}`);
  }
  const batteries = deviceList.filter((d) => d.type === 'BATTERY');

  // 3. Inverter telemetry: replaces V1 /equipment/{id}/{sn}/data.
  const inverters = await api(token, `/sites/${siteId}/inverters/telemetry`, {
    from: oneHourAgo, to: nowLocal, resolution: 'QUARTER_HOUR',
  }, { save: 'inverters-telemetry' });
  for (const [sn, metrics] of Object.entries(inverters.body?.inverters ?? {})) {
    const latest = Object.entries(metrics).map(([m, s]) => `${m}=${lastValue(s)?.value ?? '-'}${s?.unit ?? ''}`).join(' ');
    console.log(`  ${sn}: ${latest}`);
  }

  // 4. Storage telemetry, recent: SoE + remaining energy → SoH. Replaces V1 /storageData.
  const storage = await api(token, `/sites/${siteId}/storage/telemetry`, {
    from: oneHourAgo, to: nowLocal, resolution: 'QUARTER_HOUR',
  }, { save: 'storage-telemetry' });
  const storageBySn = storage.body?.storage ?? {};
  if (!Object.keys(storageBySn).length) console.log('  (no storage devices in response)');
  for (const [sn, metrics] of Object.entries(storageBySn)) {
    const latest = Object.fromEntries(Object.entries(metrics).map(([m, s]) => [m, lastValue(s)?.value]));
    console.log(`  ${sn}: ${JSON.stringify(latest)}`);
    const nameplate = batteries.find((b) => b.serialNumber === sn)?.nameplate;
    if (latest.remainingEnergy && latest.stateOfEnergy && nameplate) {
      // Documented as a 0–100 percentage, but returned as a 0–1 fraction.
      const soe = latest.stateOfEnergy <= 1 ? latest.stateOfEnergy * 100 : latest.stateOfEnergy;
      const fullPack = (latest.remainingEnergy * 100) / soe;
      console.log(`  derived fullPackEnergyAvailable=${fullPack.toFixed(0)}Wh, SoH vs nameplate ${nameplate}: ${((100 * fullPack) / nameplate).toFixed(1)}%`);
    }
  }

  // 5. Storage lifetime totals: replaces lifeTimeEnergyCharged/Discharged.
  const storageTotal = await api(token, `/sites/${siteId}/storage/telemetry`, {
    from: `${installDay}T00:00:00`, to: nowLocal, resolution: 'TOTAL',
  }, { save: 'storage-telemetry-total' });
  for (const [sn, metrics] of Object.entries(storageTotal.body?.storage ?? {})) {
    const totals = Object.fromEntries(Object.entries(metrics).map(([m, s]) => [m, lastValue(s)?.value]));
    console.log(`  ${sn} lifetime: ${JSON.stringify(totals)}`);
  }

  // 6. Daily energy, last 30 days: replaces V1 /energy?timeUnit=DAY for the forecaster.
  const energy = await api(token, `/sites/${siteId}/energy`, {
    from: `${addDays(today, -30)}T00:00:00`, to: `${today}T00:00:00`, resolution: 'DAY',
  }, { save: 'energy-day-30' });
  const days = energy.body?.values ?? [];
  console.log(`  ${days.length} values, unit=${energy.body?.unit}, first=${JSON.stringify(days[0])}, last=${JSON.stringify(days[days.length - 1])}`);

  // 7. 15-min power, yesterday's daylight: replaces V1 /power for the clipping cap.
  const power = await api(token, `/sites/${siteId}/power`, {
    from: `${yesterday}T06:00:00`, to: `${yesterday}T18:00:00`, resolution: 'QUARTER_HOUR',
  }, { save: 'power-yesterday' });
  const watts = (power.body?.values ?? []).map((v) => v.value).filter((v) => typeof v === 'number');
  console.log(`  ${watts.length} values, unit=${power.body?.unit}, max=${watts.length ? Math.max(...watts) : '-'}`);

  // 8. Overview, today: candidate for the energyOverview long poll.
  const overview = await api(token, `/sites/${siteId}/overview`, {}, { save: 'overview-today' });
  console.log(`  ${JSON.stringify(overview.body).slice(0, 400)}`);

  // 9. Lifetime production: candidate for meter_power (LIFE_TIME).
  const lifetime = await api(token, `/sites/${siteId}/energy`, {
    from: `${installDay}T00:00:00`, to: nowLocal, resolution: 'TOTAL',
  }, { save: 'energy-total' });
  console.log(`  ${JSON.stringify(lifetime.body).slice(0, 300)}`);

  // 10. Meter totals: candidate for imported/exported totals.
  const meters = await api(token, `/sites/${siteId}/meters/telemetry`, {
    from: `${installDay}T00:00:00`, to: nowLocal, resolution: 'TOTAL',
  }, { save: 'meters-telemetry-total' });
  console.log(`  ${JSON.stringify(meters.body).slice(0, 500)}`);

  // 11. Power flow: Advanced Monitoring, expected 403 on the Free tier.
  const flow = await api(token, `/sites/${siteId}/power-flow`, {}, { save: 'power-flow' });
  console.log(`  power-flow on this tier: ${flow.status}${flow.ok ? ` ${JSON.stringify(flow.body).slice(0, 300)}` : ''}`);

  console.log(`\n${callCount} API calls made. Raw responses in .cache/solaredge-v2/responses/.`);
}

// ---------------------------------------------------------------- compare

async function v1(pathname, query) {
  const apikey = process.env.SOLAREDGE_API_KEY;
  if (!apikey) fail('`compare` needs SOLAREDGE_API_KEY (V1) in .env.');
  const url = new URL(`${V1_BASE}${pathname}`);
  for (const [k, v] of Object.entries({ ...query, api_key: apikey, format: 'json' })) url.searchParams.set(k, v);
  const res = await fetch(url);
  console.log(`\nV1 GET ${pathname} -> ${res.status}`);
  if (!res.ok) fail(`V1 call failed: ${await res.text()}`);
  return res.json();
}

// V2 caps DAY resolution at one month per call, so split the range.
async function v2Daily(token, siteId, endpoint, from, to, extract) {
  const out = new Map();
  for (let start = from; start < to;) {
    const end = addDays(start, 28) < to ? addDays(start, 28) : to;
    const { ok, body } = await api(token, endpoint, {
      from: `${start}T00:00:00`, to: `${end}T00:00:00`, resolution: 'DAY',
    }, { save: `compare${endpoint.replace(/\//g, '-')}-${start}` });
    if (!ok) fail(`V2 ${endpoint} failed.`);
    for (const [day, value] of extract(body)) out.set(day, value);
    start = end;
  }
  return out;
}

const dayOf = (timestamp) => String(timestamp).slice(0, 10);

async function compare({ days }) {
  const token = await validToken();
  const siteId = siteIdOf(token);
  const site = await siteDetails(token, siteId);
  const timeZone = site.location?.timezone ?? site.location?.timeZone;

  const to = localDay(new Date(), timeZone); // exclusive: today is partial
  const from = addDays(to, -days);

  const v2Energy = await v2Daily(token, siteId, `/sites/${siteId}/energy`, from, to, (body) => (body?.values ?? []).map((v) => [dayOf(v.timestamp ?? v.date), v.value]));

  // Battery charge/discharge, to test V2's claim that site energy is
  // inverter output with battery flows backed out (i.e. true PV).
  const v2Storage = await v2Daily(token, siteId, `/sites/${siteId}/storage/telemetry`, from, to, (body) => {
    const daily = new Map();
    for (const metrics of Object.values(body?.storage ?? {})) {
      for (const [metric, sign] of [['chargeEnergy', 1], ['dischargeEnergy', -1]]) {
        for (const v of metrics[metric]?.values ?? []) {
          const day = dayOf(v.timestamp);
          const entry = daily.get(day) ?? { charge: 0, discharge: 0 };
          entry[sign > 0 ? 'charge' : 'discharge'] += v.value ?? 0;
          daily.set(day, entry);
        }
      }
    }
    return [...daily];
  });

  const v1Body = await v1(`/site/${siteId}/energy`, { timeUnit: 'DAY', startDate: from, endDate: addDays(to, -1) });
  const v1Energy = new Map((v1Body.energy?.values ?? []).map((v) => [dayOf(v.date), v.value]));

  const kwh = (wh) => (typeof wh === 'number' ? (wh / 1000).toFixed(2) : '   -');
  console.log(`\n${['day'.padEnd(10), 'V1 prod', 'V2 site', 'V2-V1', 'charge', 'disch', 'V1-dis+chg']
    .map((h, i) => (i ? h.padStart([8, 8, 8, 7, 6, 10][i - 1]) : h)).join(' ')}`);
  const rows = [];
  for (let day = from; day < to; day = addDays(day, 1)) {
    const a = v1Energy.get(day);
    const b = v2Energy.get(day);
    const s = v2Storage.get(day);
    const expected = typeof a === 'number' && s ? a - s.discharge + s.charge : null;
    rows.push({
      a, b, s, expected,
    });
    const diff = typeof a === 'number' && typeof b === 'number' ? b - a : null;
    console.log([
      day,
      kwh(a).padStart(8),
      kwh(b).padStart(8),
      kwh(diff).padStart(8),
      kwh(s?.charge).padStart(7),
      kwh(s?.discharge).padStart(6),
      kwh(expected).padStart(10),
    ].join(' '));
  }

  const both = rows.filter((r) => typeof r.a === 'number' && typeof r.b === 'number');
  const sum = (xs) => xs.reduce((t, x) => t + x, 0);
  if (both.length) {
    const ratio = sum(both.map((r) => r.b)) / sum(both.map((r) => r.a));
    console.log(`\n${both.length} days with both: V2/V1 total ratio ${ratio.toFixed(3)}`);
    const withStorage = both.filter((r) => r.expected !== null);
    if (withStorage.length) {
      const err = sum(withStorage.map((r) => Math.abs(r.b - r.expected))) / sum(withStorage.map((r) => r.b));
      console.log(`V2 vs (V1 - discharge + charge): mean abs error ${(err * 100).toFixed(1)}% of V2`);
    }
  }
  console.log(`\n${callCount} V2 API calls made.`);
}

// ---------------------------------------------------------------- main

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      code: { type: 'string' },
      site: { type: 'string' },
      extra: { type: 'string' },
      days: { type: 'string', default: '60' },
    },
  });

  const command = positionals[0] ?? 'probe';
  switch (command) {
    case 'auth': return auth(values);
    case 'refresh': {
      const token = await loadToken();
      if (!token) fail('No token yet. Run `npm run v2 -- auth` first.');
      return refreshToken(token);
    }
    case 'probe': return probe();
    case 'compare': return compare({ days: Number(values.days) });
    default: return fail(`Unknown command "${command}". Use auth, refresh, probe or compare.`);
  }
}

main().catch((err) => {
  console.error(err instanceof UsageError ? err.message : err);
  process.exitCode = 1;
});
