# SolarEdge V1 sunset: findings and decision

Written 2026-10-04. The SolarEdge V1 Monitoring API (`monitoringapi.solaredge.com/...?api_key=`) stops responding on **2026-11-03** (one docs page says 11-01).

**Decision: internal API only.** Every V1 call the app made now goes to the monitoring web app's internal `/services/dashboard/*` endpoints, using the same username/password cookie session the app already used for live data. The app no longer has an API key setting, uses no V2, and needs no developer account. This document records what was learned, so the V2 route can be picked up again without redoing the research.

## 1. Background: how the app talked to SolarEdge

| Mechanism | How | Affected by the V1 sunset |
|---|---|---|
| Internal web/mobile API (reverse engineered) | `POST /solaredge-apigw/api/login` with `j_username`/`j_password`, then a session cookie on `monitoring.solaredge.com/services/...` | No. It's unofficial and can change without notice, but it isn't the V1 public API. |
| V1 public API | `monitoringapi.solaredge.com/...?api_key=` with a per-site key in device settings | **Yes** |

The app never used OAuth.

## 2. What changed in the app

| Was (V1) | Now (internal) | Used by |
|---|---|---|
| `GET /site/{id}/details` | `GET /services/dashboard/site-details/{id}/details` → `peakPower` (kWp), `latitude`, `longitude`, `installationDate` | forecaster, battery |
| `GET /site/{id}/energy?timeUnit=DAY` | `GET /services/dashboard/energy/sites/{id}?chart-time-unit=days&measurement-types=production` → `chart.measurements[].production` (Wh) | forecaster |
| `GET /site/{id}/power` | `GET /services/dashboard/power/sites/{id}?chart-time-unit=quarter-hours&measurement-types=production` → `measurements[].production` (W) | forecaster clipping cap |
| `GET /site/{id}/storageData` → lifetime charged/discharged | `GET /services/dashboard/storage/energy/distribution/sites/{id}` (install date → today) → `sources.total` / `destinations.total` (Wh) | battery |
| `storageData` → `fullPackEnergyAvailable` (SoH) | **Estimated** from discharge energy per % of SoC (§5) | battery |
| `storageData` → `internalTemp` | removed (`measure_temperature` on battery) | — |
| `GET /equipment/{id}/list` + `/equipment/{id}/{sn}/data` → AC voltage, DC voltage, temperature | removed (`measure_voltage`, `measure_voltage.dc`, `measure_temperature` on inverter) | — |
| `GET /sites/list` (API key check in settings) | removed with the `apikey` setting | — |
| `getSiteCurrentPowerFlow` | removed (it had no callers) | — |

New in passing: battery `meter_power.charged_today`/`discharged_today` were declared but never set. They're now filled from the same distribution endpoint, using today's range.

Retired capabilities are removed from existing devices in `onInit`.

Code: `lib/SolarEdgeAPI.mjs` (`getDashboard` and the methods after it), `lib/SolarForecaster.mjs` (block-cached history), `lib/BatteryHealth.mjs`, `drivers/battery/device.mjs`, `drivers/inverter/device.mjs`. Harnesses: `npm run internal`, `npm run forecast`, `npm run v2`.

The internal calls kept as they were are the live powerflow every 10 s, energy overview, meter energy summary, home-automation devices and EV/HLC control.

## 3. Internal API reference

All are `GET https://monitoring.solaredge.com/services/dashboard/...`, authenticated with the login cookie. Dates are `YYYY-MM-DD` in site-local time, ranges are inclusive, and `measurement-types` is repeated rather than comma-joined. They were found by crawling the public JS bundles of the `monitoring.solaredge.com/one` web app (module federation chunks on `cni-prod-cdn.solaredge.com`).

| Endpoint | Returns | Measured range limit |
|---|---|---|
| `/site-details/{id}/details` | siteId, name, peakPower, latitude, longitude, installationDate, status, backupReserve | — |
| `/site-details/{id}/metadata` | similar, without backup fields | — |
| `/site-details/{id}/components` | hasStorage, hasConsumptionAndGrid, hasDcStorage, inverterCount, … | — |
| `/v2/site-details/{id}/equipment` | inverters (model, serials), optimizers, storage (manufacturer, serial, capacity kWh), meters | — |
| `/site-details/{id}/equipment-inverter/{sn}` | firmware versions, communication, partNumber. **No telemetry.** | — |
| `/energy/sites/{id}?start-date&end-date&chart-time-unit&measurement-types` | `summary` + `chart.measurements[]` with `production`, `productionDistribution` (toHome/toBattery/toGrid), `consumption`, `consumptionDistribution` (fromBattery/fromSolar/fromGrid), `import`, `export`. Types: `production`, `consumption`, `production-distribution-with-storage`, `consumption-distribution-with-storage`, `import`, `export`, `yield`. | `days`: 93 OK, 120 rejected (`BAD_ARGUMENTS DAYS`). `quarter-hours`: 1 day. `years`: install → today OK. |
| `/power/sites/{id}?…&chart-time-unit=quarter-hours&measurement-types=production` | `measurements[]` with `production` (W); same types as energy. Without `measurement-types` it returns 400. | 8 days OK, 14 rejected |
| `/inverters/power/sites/{id}?…&chart-time-unit=quarter-hours\|hours` | `invertersDatedPowerList[].inverterPowerArray` (W per inverter) | 28 days at `hours` OK |
| `/inverters/energy/sites/{id}?…&chart-time-unit=days` | per-inverter energy total for the range | — |
| `/battery/sites/{id}?start-date&end-date` | `measurements[].stateOfCharge` (%): 5-min for 1 day, 15-min for 2. Future slots are null. | 2 days OK, 7 rejected |
| `/storage/energy/distribution/sites/{id}?start-date&end-date` | `sources` {total, pv, grid}, `destinations` {total, building, grid}, in Wh | install → today OK |
| `/power-flow/v2/sites/{id}?components=…` | newer live power flow, `updateRefreshRate: 3`, same shape as the mobile one the app polls | — |
| `/live-power/sites/{id}` | `currentAcPower` | — |
| `/services/cni/ui-api/sites/{id}` | timezone, location, peakPowerPkw | — |
| `POST /services/layout/information/optimizers` with a JSON array of optimizer serials | per optimizer: model, and its modules' `tilt`/`azimuth` (radians; azimuth anticlockwise from north, so compass = 360° − azimuth), manufacturer and model; plus live `power_W`, voltage, current. Cookie login is enough (the web app also sends `x-se-user-id`, not needed). | 22 serials in one call OK |
| `/services/cni/ui-api/user-info` | userId, email, names, display units | — |
| `/services/cni/ui-api/pages/operations/commands/site/{id}/devices/communication` | inverter, battery and meter serials and connectivity (no optimizers) | — |

`GET /services/layout/physical/site/{id}` lists the optimizer serials (`physicalDevicesMap.optimizers[].serialNumber`, plus inverters and strings). It also returns presigned S3 links (valid 5 days) to the site's Designer model and image. Cookie login is enough. With the POST above, that's the drawn layout in two requests.

**Not used: the layout is the installer's drawing, not a survey.** On the author's site it puts the 13 panels in a separate column, which they aren't (aerial photo), and its directions don't match a phone compass. Read as plain compass bearings, the stored azimuths say 69° for the 13 and 341° for the 9. The compass on the roof says 306° and 33°, roughly the reverse. No reading of the azimuths gets both groups right. So the app takes panel groups from settings, and `npm run forecast -- detect` checks them against production.

The author's site: 22 × Canadian Solar CS6P-260 (5.72 kWp), flush on a 22° roof (owner; the installer's drawing says 20°). By phone compass (true north), 13 face 306° (NW) and 9 face 33° (NE). Detection from clear-day production finds the combined direction at 339°, matching the 13/9 weighted mean of 340°. It can't split the direction into two groups: on clear days two roof faces look like one plane at their average direction. A 300-day backtest barely separates orientations: daily error is 15.9% for a single plane facing north and 15.6% for the measured groups. Calibration, the seasonal multiplier and the shading profile absorb most of a wrong direction.
| `/services/m/so/dashboard/site/{id}/energyOverview` | LIFE_TIME/LAST_YEAR/LAST_MONTH/LAST_DAY energy (already used) | — |

Not reachable with a homeowner login: `/services/charts/site/{id}/tree` and `/devices-measurements` (the Charts tab) return 403 `NO_PERMISSION`. That's the only internal source of inverter AC/DC voltage. The `/services/charts/measurements-map` catalogue lists no inverter or battery temperature at all.

The mobile `/services/m/so/dashboard/site/{id}/storage` and `/v2/site/{id}/battery` return 403.

## 4. Data findings (the author's site: SE5000, 5.72 kWp, DC-coupled Tesla Powerwall 6.4 kWh)

**V1's 15-minute power counts battery discharge as solar production.** On 2026-10-03, V1 `/power` read 592 W at 06:00 (before sunrise) and 1.4–1.7 kW through a cloudy afternoon. Its 15-minute values summed to 11.6 kWh, while V1's own daily energy said 5.4 kWh. Internal `/power` (and V2 `/power`) read 0 W at night and summed to 6.1 kWh. This is why forecast phase 2 had to fall back to a seasonal profile. The internal data unblocks the hourly shading profile.

**Daily energy**: internal = V2 to the byte (same backend). Over 60 days, V2 ≈ V1 − battery discharge + battery charge, within 2.2%. Internal/V2 daily PV runs 0.65–1.1 kWh/day (~5–6%) above V1.

**Forecast backtest** (90 days, day-ahead, phase 2 model): error 20.5% → **19.5%**, bias +0.4% → **+0.1%**. Cap 4,828 W, now from true PV.

**Battery lifetime totals**: internal 18,244 kWh charged / 17,557 kWh discharged, against V1's battery counters of 18,222 / 17,333. V2 gave 62,725 / 59,790, about 3.4× too high.

## 5. Battery state of health estimate

There's no SoH or full-pack energy anywhere in the internal API, so it's estimated in `lib/BatteryHealth.mjs`:

1. Once a day after 01:00, fetch yesterday's SoC (`/battery`, 5-min) and 15-minute `consumptionFromBattery` (`/energy`, quarter-hours, `consumption-distribution-with-storage`). That's 2 requests.
2. Find runs of 15-minute slots where SoC never rises and falls by **≥ 40 points**. A data gap ends a run. Full pack = discharged Wh × 100 / points lost.
3. Keep the runs from the last 30 days in the device store. Take the median full pack (at least 3 runs needed).
4. Correct for energy lost inside the battery while discharging: divide by √(lifetime discharged ÷ charged), using the distribution endpoint's lifetime totals the device already fetches. That's the round-trip efficiency, assuming losses split evenly between charging and discharging. It's clamped to 0.85–1.
5. SoH = corrected full pack ÷ rated capacity (sum of `equipment.storage.details[].capacity`), capped at 100%.

Only discharge is used. Charging includes grid charging, which isn't broken out per 15-minute slot, and charge losses would inflate the figure. Battery-to-grid discharge isn't in `consumptionFromBattery`, but it was under 1% here.

**Validation against V1** (`fullPackEnergyAvailable` = 4,624 Wh = 72.3%), 20 runs over 10 days (full 100→5% runs: 4,389–4,833 Wh):

| Method | Full pack | Error |
|---|---|---|
| Raw median | 4,478 Wh | −3.2% |
| ÷ √(lifetime ratio 0.962) **(used)** | 4,565 Wh (71%) | −1.3% |
| ÷ √(30-day ratio 0.951) | 4,592 Wh | −0.7% |
| ÷ lifetime ratio (whole round trip) | 4,653 Wh | +0.6% |
| ÷ 30-day ratio | 4,709 Wh | +1.8% |
| Regression with a constant self-use term | 4,930 Wh (38 W) | +6.6%, unstable |

The shortfall is not inverter loss. `consumptionFromBattery` matches the distribution endpoint's `destinations.building` exactly (234,082 Wh over 30 days), and those totals are within about 1% of the battery's own V1 counters, so delivered energy is metered on about the same basis as the battery's counters. The likely cause is losses inside the battery (internal resistance, BMS and thermal draw).

The lifetime ratio is used rather than a recent one. The 30-day ratio swings with usage and season, because standby draw weighs more on quiet days, and that would show up as health changes that aren't there.

As the battery ages, its efficiency falls and the correction grows. The figure then tracks capacity, as V1's did, rather than deliverable energy. It's good for trend tracking, not an exact match.

## 6. V2 findings (for if we revisit)

### Why we didn't use it
- The internal login's credentials don't work on V2 (tested 2026-10-04). Session cookies get 401 "access token is missing". `JSESSIONID` or `SolarEdge_SSO-1.4` sent as a Bearer token gets 401 "access token is invalid". The SSO cookie sent as `X-API-Key` gets 401. None of the cookies is a JWT, and the web app's `/services/auth/refresh` doesn't issue a token to this session (405 on GET, 400 on POST). V2 only accepts its own OAuth tokens or a Fleet API key.
- It needs a developer account plus an OAuth (Site Access) app, then an OAuth grant per homeowner. There's no personal access token yet. Fleet API keys are for installer accounts only.
- It needs refresh-token handling in the app. Access tokens last 2 h, refresh tokens rotate on every use and expire after 30 days unused.
- On the Free tier (2,000 credits/month, 10 calls/minute, 1 credit per call), a 10 s live poll is impossible. Even hourly polling of a few endpoints uses a big share of the budget.
- It gives the same energy/power data as the internal API (same backend). Its only extras are inverter AC voltage and battery SoE/remaining energy (exact SoH). Its lifetime battery totals are wrong.
- It's read-only, so it can't control the EV charger or Home Load Controller. A "Fleet Management API" is announced.

### What worked
- Developer console: developer.solaredge.com, signing in with the normal SolarEdge login. A Site Access app was created; it's named "test" on the consent screen.
  - Redirect URIs: `http://localhost:8080/oauth/callback` (and `https://callback.athom.com/oauth2/callback` for a future Homey flow)
  - Scopes: SITE_DATA + DEVICE_DATA
  - Credentials: `SOLAREDGE_CLIENT_ID`/`SOLAREDGE_CLIENT_SECRET` in `.env`
- OAuth with `npm run v2 -- auth`: `https://connect.solaredge.com/authorize?client_id=…` → SolarEdge SSO → consent → redirect with `code` and `site_id`. Then `POST /v2/oauth2/token` with a JSON body (`grant_type`, `code`, `client_id`, `client_secret`, `redirect_uri`) returns `expires_in: 7200` and a refresh token. Refresh works and rotates the refresh token.
- The grant is still live, with the token in `.cache/solaredge-v2/token.json`. Revoke with `POST /v2/oauth2/revoke-token {"token": …}`, or let it lapse (30 days unused).
- `npm run v2 -- probe` (11 calls) and `npm run v2 -- compare` (7 calls) both run.

### Where the docs are wrong
- The homeowner guide's authorize URL (`scope`, `redirect_uri`, `state`, `access_duration`) gives **"Configuration Error 400.4"**. Use `client_id` alone. Which parameter breaks it isn't bisected yet (`npm run v2 -- auth --extra scope,state,…`). Grant length without `access_duration` is unknown.
- `from`/`to` must be **Instants** (`2026-10-04T08:15:00Z`). The docs' local datetimes return 400 "Failed to convert … to required type [Instant]".
- `stateOfEnergy` is a **0–1 fraction**, not 0–100.
- `GET /v2/sites/{id}/power-flow` returned 200 with a 3 s refresh on the **Free** tier, though the docs say Business Pro. That's probably the migration grace period.
- `GET /v2/sites` (site list) doesn't accept OAuth. The site ID comes from the callback.
- `devices` includes retired batteries and meters; filter on `active`.
- Rejected calls count against the per-minute limit.
- `GET /v2/sites/{id}/energy` / `power`: DAY ≤ 1 month, QUARTER_HOUR ≤ 12 h per call.

### V2 endpoints we'd use
- `/v2/sites/{id}`
- `/v2/sites/{id}/devices`
- `/v2/sites/{id}/inverters/telemetry` (power, energy, voltage, current, frequency)
- `/v2/sites/{id}/storage/telemetry` (chargePower, dischargePower, chargeEnergy, dischargeEnergy, remainingEnergy, stateOfEnergy)
- `/v2/sites/{id}/energy`, `/power`, `/overview`
- `/v2/sites/{id}/meters/telemetry`

The full API inventory and migration table are at https://api-docs.solaredge.com/docs/basic-monitoring-api/m32bx376ka8mb-migrating-from-v1-to-v2. The OpenAPI specs can be fetched from Stoplight: project `cHJqOjMxMjQ1NQ` (basic), `cHJqOjMxMjQ1OQ` (advanced).

### If we revisit
The likely triggers are that the internal API breaks, gets blocked or adds MFA, or that we want AC voltage or an exact SoH back.
1. Re-run `npm run v2 -- auth` (the minimal URL works) and `npm run v2 -- probe`.
2. For Homey, add an OAuth pairing/repair step via `this.homey.cloud.createOAuth2Callback(url)` (redirect `https://callback.athom.com/oauth2/callback`, already registered). Store the token pair in the device store and save the rotated refresh token before using it.
3. Budget credits. Persist caches across restarts, pace to ≤ 9 calls/minute, and route 429s on `x-ratelimit-remaining-minute` (0 = wait for the minute, > 0 = monthly credits exhausted).
4. Live power flow and EV/HLC control would still need the internal API.

## 7. Risks of the internal-only approach
- **It's undocumented.** SolarEdge can change or block these endpoints, or put MFA on the login. The app already depended on this for live data, so this adds no new kind of risk, just more surface. Section 6 is the fallback.
- If login breaks, every device goes unavailable together. The stale-data watchdog in `SolarEdgeDevice` makes that visible.
- Request limits (§3) were measured, not documented, and could tighten. The forecaster's blocks (calendar months, 7 days) leave headroom.
