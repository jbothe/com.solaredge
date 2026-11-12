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

/*
 * Homey moves a capability's lastUpdated only when its value changes, and the Energy tab stops
 * showing a device's watts, and its flow, once that is a while ago. On 2026-10-18 a grid charge held
 * a steady 3290 W from 11:00; by 11:35 the battery tile read just "Charging" while Homey's live
 * energy report still had the 3290 W. A power held unchanged for REFRESH_AFTER is therefore written
 * 1 W towards zero and straight back, which refreshes it (checked on the device during the next
 * morning's grid charge).
 *
 * Towards zero, so a charge or discharge does not flip direction for that instant. 0 W is left
 * alone: a dropped 0 W shows the same as a stale one, and an inverter would otherwise blip all night.
 * A `measure_power_changed` flow runs on both writes.
 */

const REFRESH_AFTER = 5 * 60 * 1000;

// what Homey Energy reads of a device
const CAPABILITIES = new Set(['measure_power']);

/**
 * The values to write to `capability` for `value`: [value], or [nudged, value] when the device has
 * held `value` for REFRESH_AFTER. Keeps when each capability last changed on the device.
 * @param {Homey.Device} device
 * @param {string} capability
 * @param {*} value
 * @param {number} [now] epoch ms
 * @returns {Array} the values, in order
 */
function steadyWrites(device, capability, value, now = Date.now()) {
  if (!CAPABILITIES.has(capability)) return [value];
  if (!device.powerChangedAt) device.powerChangedAt = new Map();
  const since = device.powerChangedAt.get(capability);
  if (since === undefined || value !== device.getCapabilityValue(capability)) {
    device.powerChangedAt.set(capability, now);
    return [value];
  }
  if (now - since < REFRESH_AFTER) return [value];
  device.powerChangedAt.set(capability, now);
  if (typeof value !== 'number' || value === 0) return [value];
  return [value - Math.sign(value), value];
}

module.exports = { REFRESH_AFTER, steadyWrites };
