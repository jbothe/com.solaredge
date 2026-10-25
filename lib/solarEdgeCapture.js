/*
Copyright 2026, Robin de Gruijter (rmdegruijter@gmail.com)

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

/*
Raw API responses in the app log, so a user's diagnostics report doubles as test material (as
com.foxess lib/foxEssCapture.js). Each call (method + arguments) is logged once per arm (app
start, device restart, pairing), in chunks. `node test/from-logs.js <report.txt>` turns a report
back into test/captures/<siteId>.json for test/responses.js.
*/

const captureLog = require('./captureLog');

// Contact details and signed links in the calls that describe the site; the site name is usually
// its street address. Serial numbers, ids, device names and all other calls are kept as they are,
// apart from the vehicle (VEHICLE_KEYS).
const SITE_METHODS = new Set(['getSites', 'getSiteInformation', 'getSiteDetails', 'getSiteLayout']);
const PII_KEYS = new Set(['name', 'siteName', 'address', 'address2', 'city', 'fieldCity', 'zip', 'state', 'stateCode',
  'latitude', 'longitude', 'email', 'phone', 'accountName', 'accountGuid', 'linkSmallImage', 'linkBigImage',
  'bigImageDownloadLink', 'image']);

const redactSite = (value) => {
  if (Array.isArray(value)) return value.map(redactSite);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // a name below the site (inverter, string, optimizer in the layout) is kept
    if (k === 'name' && value.type && value.type !== 'SITE') out[k] = v;
    else if (PII_KEYS.has(k) && v !== null) out[k] = '<redacted>';
    else out[k] = redactSite(v);
  }
  return out;
};

// The vehicle in an EV charger's applianceData (getSiteDevices): licence plate and ids, in every call
const VEHICLE_KEYS = new Set(['physicalId', 'siteApplianceUUID']);

const redactVehicle = (value, parentKey) => {
  if (Array.isArray(value)) return value.map((item) => redactVehicle(item, parentKey));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && (VEHICLE_KEYS.has(k) || (parentKey === 'applianceData' && k === 'id'))) out[k] = '<redacted>';
    else out[k] = redactVehicle(v, k);
  }
  return out;
};

const redactResult = (method, result) => redactVehicle(SITE_METHODS.has(method) ? redactSite(result) : result);

/** Argument objects as a key that ignores property order (as test/harness.js callKey). */
const callKey = (method, args) => `${method} ${JSON.stringify(Object.fromEntries(Object.entries(args ?? {}).sort()))}`;

const core = captureLog('SOLAREDGE', { maxBytes: 64 * 1024 });
let count = 0;

const capture = {

  /**
   * Arm capturing: the next answer to every distinct call is logged once.
   * @param {string} why shown in the log
   * @param {object} [options] { force }: skip the cooldown (app start, pairing)
   */
  arm(why, options) {
    return core.arm(why, options);
  },

  /**
   * Log one call while armed, once per method + arguments per arm.
   * @param {object} call { method, args, result } or { method, args, error: { message, code, status } }
   * @param {Function} log the app/device logger
   */
  record({
    method, args, result, error,
  }, log) {
    if (typeof log !== 'function' || !core.claim(callKey(method, args))) return false;
    count += 1;
    return core.write(`${method}_${count}`, {
      method, args, at: Date.now(), ...(error ? { error } : { result: redactResult(method, result) }),
    }, log);
  },

  /**
   * The client with every get* call recorded; everything else passes through. One wrapper per
   * client: devices compare clients by identity.
   */
  wrap(client, log) {
    return new Proxy(client, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== 'function' || typeof property !== 'string') return value;
        if (!/^get[A-Z]/.test(property)) return value.bind(target);
        return async (args) => {
          try {
            const result = await value.call(target, args);
            capture.record({ method: property, args, result }, log);
            return result;
          } catch (error) {
            capture.record({
              method: property,
              args,
              error: {
                message: error.message, name: error.name, code: error.code, status: error.status,
              },
            }, log);
            throw error;
          }
        };
      },
    });
  },

  /**
   * Read the captured calls back out of a diagnostics report; anchors on `<name>|<index>|`, so
   * line prefixes don't matter.
   * @param {string} text the whole report
   * @returns {{calls: object[], errors: string[]}} the calls in the order they were logged
   */
  parseLog(text) {
    const { entries, errors } = core.parse(text);
    return { calls: entries.map((entry) => entry.value), errors };
  },

};

module.exports = capture;
