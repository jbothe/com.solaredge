import assert from 'node:assert/strict';
import { test } from 'node:test';

import energyShares from '../lib/EnergyShares.mjs';

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
