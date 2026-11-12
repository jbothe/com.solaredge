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
 * Without a network: today's self-consumption and self-sufficiency on the meter
 * (lib/energyShares.js), the battery's charge sources, and the steady-power refresh for Homey
 * Energy (lib/steadyPower.js) through both device bases.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { manifest } = require('./harness');
const energyShares = require('../lib/energyShares');
const { REFRESH_AFTER, steadyWrites } = require('../lib/steadyPower');

const ROOT = path.join(__dirname, '..');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const newDevice = (driverId, client) => {
  const DeviceClass = require(path.join(ROOT, 'drivers', driverId, 'device.js')); // eslint-disable-line import/no-dynamic-require, global-require
  const driverManifest = manifest.drivers.find((driver) => driver.id === driverId);
  const device = new DeviceClass({ driverManifest, data: { siteId: 1 }, settings: {} });
  device.client = client;
  return device;
};

// --- the fork's test/EnergyShares.test.mjs ----------------------------------------------------------
{
  // The author's site on 2026-10-05 (to mid-morning), in Wh.
  const summary = {
    production: 2250,
    consumption: 13080,
    import: 11860,
    export: 60,
    productionDistribution: { productionToHome: 1590, productionToBattery: 610, productionToGrid: 60 },
    consumptionDistribution: { consumptionFromSolar: 1590, consumptionFromBattery: 4100, consumptionFromGrid: 7390 },
  };

  test('self-consumption is the solar used at home or stored', () => {
    const { selfConsumption } = energyShares(summary, { total: 5000, pv: 600 });
    assert.ok(Math.abs(selfConsumption - 2200 / 2250) < 1e-12);
  });

  test('self-sufficiency counts battery energy only for its solar share', () => {
    // 12% of what charged the battery was solar.
    const { selfSufficiency } = energyShares(summary, { total: 5000, pv: 600 });
    assert.ok(Math.abs(selfSufficiency - (1590 + 4100 * 0.12) / 13080) < 1e-12);
    assert.equal(Math.round(selfSufficiency * 100), 16);

    // A battery charged only from the grid adds nothing.
    assert.ok(Math.abs(energyShares(summary, { total: 5000, pv: 0 }).selfSufficiency - 1590 / 13080) < 1e-12);
  });

  test('without distributions it falls back to export and import, clamped to 0–100%', () => {
    const plain = {
      production: 6000, consumption: 10000, import: 7000, export: 1500,
    };
    const shares = energyShares(plain, null);
    assert.equal(shares.selfConsumption, 0.75);
    assert.equal(shares.selfSufficiency, 0.3);

    // Importing more than was used (grid charging the battery) floors at 0.
    assert.equal(energyShares({ ...plain, import: 12000 }, null).selfSufficiency, 0);
  });

  test('nothing produced or used gives no figure rather than a division by zero', () => {
    assert.deepEqual(energyShares({ production: 0, consumption: 0 }, null), { selfConsumption: null, selfSufficiency: null });
    assert.deepEqual(energyShares(undefined, undefined), { selfConsumption: null, selfSufficiency: null });
  });
}

// --- the meter's shares and the battery's charge sources ------------------------------------
{
  const TODAY = '2026-10-05';
  const summary = {
    production: 2250,
    consumption: 13080,
    import: 11860,
    export: 60,
    productionDistribution: { productionToHome: 1590, productionToBattery: 610, productionToGrid: 60 },
    consumptionDistribution: { consumptionFromSolar: 1590, consumptionFromBattery: 4100, consumptionFromGrid: 7390 },
  };
  const client = (calls) => ({
    getSites: async () => ({ 1: { id: 1, timezone: 'UTC' } }),
    getSiteEnergyChart: async (args) => {
      calls.push(['energy', args]);
      return { summary };
    },
    getSiteStorageDistribution: async (args) => {
      calls.push(['storage', args]);
      return { sources: { total: 5000, pv: 600, grid: 4400 }, destinations: { total: 4100 } };
    },
  });

  test('meter on a battery site: with-storage distributions and the battery\'s solar share', async () => {
    const calls = [];
    const meter = newDevice('meter', client(calls));
    meter.storage = true;
    meter.siteToday = async () => TODAY;
    await meter.updateShares(1);
    assert.deepEqual(calls.map(([kind]) => kind), ['energy', 'storage']);
    assert.deepEqual(calls[0][1], {
      siteId: 1,
      timeUnit: 'days',
      startDate: TODAY,
      endDate: TODAY,
      measurementTypes: ['production', 'consumption', 'production-distribution-with-storage', 'consumption-distribution-with-storage', 'import', 'export'],
    });
    assert.deepEqual(calls[1][1], {
      siteId: 1, timeUnit: 'days', startDate: TODAY, endDate: TODAY,
    });
    assert.equal(meter.getCapabilityValue('solar_self_consumption'), 98);
    assert.equal(meter.getCapabilityValue('solar_self_sufficiency'), 16);
    assert.deepEqual(meter.problems, []);
  });

  test('meter without a battery: without-storage distributions, no storage call', async () => {
    const calls = [];
    const meter = newDevice('meter', client(calls));
    meter.storage = false;
    meter.siteToday = async () => TODAY;
    await meter.updateShares(1);
    assert.deepEqual(calls.map(([kind]) => kind), ['energy']);
    assert.ok(calls[0][1].measurementTypes.includes('production-distribution-without-storage'));
    // no battery sources: battery energy counts as not solar
    assert.equal(meter.getCapabilityValue('solar_self_sufficiency'), Math.round((1590 / 13080) * 100));
  });

  test('meter shares are manifest capabilities, after the energy meters', () => {
    const { capabilities } = manifest.drivers.find((driver) => driver.id === 'meter');
    assert.ok(capabilities.indexOf('meter_power.exported') < capabilities.indexOf('solar_self_sufficiency'));
    assert.ok(capabilities.includes('solar_self_consumption'));
  });

  test('battery: today\'s charge from solar and from the grid, in kWh', async () => {
    const calls = [];
    const battery = newDevice('battery', client(calls));
    battery.siteToday = async () => TODAY;
    await battery.updateChargeSources();
    assert.deepEqual(calls, [['storage', {
      siteId: 1, timeUnit: 'days', startDate: TODAY, endDate: TODAY,
    }]]);
    assert.equal(battery.getCapabilityValue('meter_power.charged_solar_today'), 0.6);
    assert.equal(battery.getCapabilityValue('meter_power.charged_grid_today'), 4.4);
    assert.deepEqual(battery.problems, []);
  });
}

// --- steady power for Homey Energy (lib/steadyPower.js) -------------------------------------
{
  /** A device as steadyWrites sees it: the capability values it holds. */
  const holder = (values = {}) => ({ getCapabilityValue: (id) => values[id] ?? null, values });

  test('a power held for 5 minutes is sent 1 W towards zero and back', () => {
    const device = holder();
    const t0 = 1_000_000;
    assert.deepEqual(steadyWrites(device, 'measure_power', 3290, t0), [3290]);
    device.values.measure_power = 3290;
    assert.deepEqual(steadyWrites(device, 'measure_power', 3290, t0 + REFRESH_AFTER - 1), [3290]);
    assert.deepEqual(steadyWrites(device, 'measure_power', 3290, t0 + REFRESH_AFTER + 1), [3289, 3290]);
    // and again only after another 5 minutes
    assert.deepEqual(steadyWrites(device, 'measure_power', 3290, t0 + REFRESH_AFTER + 2), [3290]);
    assert.deepEqual(steadyWrites(device, 'measure_power', 3290, t0 + (2 * REFRESH_AFTER) + 2), [3289, 3290]);
  });

  test('towards zero for a discharge; 0 W, other capabilities and changes are left alone', () => {
    const t0 = 2_000_000;
    const discharging = holder({ measure_power: -1500 });
    steadyWrites(discharging, 'measure_power', -1500, t0);
    assert.deepEqual(steadyWrites(discharging, 'measure_power', -1500, t0 + REFRESH_AFTER + 1), [-1499, -1500]);

    const idle = holder({ measure_power: 0 });
    steadyWrites(idle, 'measure_power', 0, t0);
    assert.deepEqual(steadyWrites(idle, 'measure_power', 0, t0 + REFRESH_AFTER + 1), [0]);

    const other = holder({ measure_battery: 80 });
    steadyWrites(other, 'measure_battery', 80, t0);
    assert.deepEqual(steadyWrites(other, 'measure_battery', 80, t0 + REFRESH_AFTER + 1), [80]);

    // a change restarts the 5 minutes
    const changing = holder({ measure_power: 1000 });
    steadyWrites(changing, 'measure_power', 1000, t0);
    changing.values.measure_power = 1000;
    assert.deepEqual(steadyWrites(changing, 'measure_power', 1200, t0 + REFRESH_AFTER - 10), [1200]);
    changing.values.measure_power = 1200;
    assert.deepEqual(steadyWrites(changing, 'measure_power', 1200, t0 + REFRESH_AFTER + 10), [1200]);
  });

  /** Every value `device` writes, per capability. */
  const recordWrites = (device) => {
    const writes = [];
    const set = device.setCapabilityValue.bind(device);
    device.setCapabilityValue = async (id, value) => {
      writes.push([id, value]);
      return set(id, value);
    };
    return writes;
  };
  const ageSteady = (device) => device.powerChangedAt.set('measure_power', Date.now() - REFRESH_AFTER - 1);

  test('the cloud devices refresh a steady power (CommonDevice#setCapability)', async () => {
    const battery = newDevice('battery', {});
    const writes = recordWrites(battery);
    await battery.setCapability('measure_power', 3290);
    await battery.setCapability('measure_power', 3290);
    ageSteady(battery);
    await battery.setCapability('measure_power', 3290);
    await battery.setCapability('measure_battery', 62);
    assert.deepEqual(writes, [['measure_power', 3290], ['measure_power', 3290], ['measure_power', 3289], ['measure_power', 3290], ['measure_battery', 62]]);
    assert.equal(battery.getCapabilityValue('measure_power'), 3290);
  });

  test('the Modbus devices refresh a steady power (ModbusDevice#setCapability)', async () => {
    const battery = newDevice('battery_modbus', {});
    const writes = recordWrites(battery);
    await battery.setCapability('measure_power', -800);
    ageSteady(battery);
    await battery.setCapability('measure_power', -800);
    assert.deepEqual(writes, [['measure_power', -800], ['measure_power', -799], ['measure_power', -800]]);
  });
}

// --- run ------------------------------------------------------------------------------------

const run = async () => {
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn(); // eslint-disable-line no-await-in-loop
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  if (failures.length) {
    console.error(`FAIL - ${failures.length} problem(s):\n`);
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`OK - energy: ${tests.length} tests of the meter's shares, the battery's charge sources and the steady-power refresh`);
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
