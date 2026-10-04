import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSlots,
  dischargeEfficiency,
  dischargeSegments,
  estimateFullPackWh,
  stateOfHealth,
} from '../lib/BatteryHealth.mjs';

const SLOT_MS = 15 * 60 * 1000;
const START = Date.parse('2026-10-03T00:00:00+10:00');
const iso = (ms) => new Date(ms).toISOString();

// A battery with fullPackWh of usable energy, discharging at a steady rate.
// SoC is reported in whole percent, as SolarEdge does.
function discharge({
  fullPackWh, fromSoc, toSoc, whPerSlot, startSlot = 0,
}) {
  const soc = [];
  const energy = [];
  let remaining = (fullPackWh * fromSoc) / 100;
  let slot = startSlot;

  while (remaining > (fullPackWh * toSoc) / 100) {
    const time = iso(START + slot * SLOT_MS);
    soc.push({ measurementTime: time, stateOfCharge: Math.round((100 * remaining) / fullPackWh) });
    energy.push({ measurementTime: time, consumptionDistribution: { consumptionFromBattery: whPerSlot } });
    remaining -= whPerSlot;
    slot += 1;
  }

  const time = iso(START + slot * SLOT_MS);
  soc.push({ measurementTime: time, stateOfCharge: Math.round((100 * remaining) / fullPackWh) });
  energy.push({ measurementTime: time, consumptionDistribution: { consumptionFromBattery: 0 } });
  return { soc, energy, endSlot: slot };
}

test('a full discharge recovers the full-pack energy', () => {
  const { soc, energy } = discharge({
    fullPackWh: 4600, fromSoc: 100, toSoc: 5, whPerSlot: 115,
  });
  const segments = dischargeSegments(buildSlots(soc, energy));

  assert.equal(segments.length, 1);
  assert.ok(Math.abs(segments[0].fullPackWh - 4600) / 4600 < 0.03, `got ${segments[0].fullPackWh}`);
});

test('5-minute SoC samples between the 15-minute slots are ignored', () => {
  const { soc, energy } = discharge({
    fullPackWh: 4600, fromSoc: 100, toSoc: 5, whPerSlot: 115,
  });
  const extra = soc.map((s) => ({ measurementTime: iso(Date.parse(s.measurementTime) + 5 * 60 * 1000), stateOfCharge: 1 }));

  const slots = buildSlots([...soc, ...extra], energy);
  assert.equal(slots.length, energy.length);
});

test('small drops and data gaps do not make segments', () => {
  const small = discharge({
    fullPackWh: 4600, fromSoc: 60, toSoc: 30, whPerSlot: 115,
  });
  assert.equal(dischargeSegments(buildSlots(small.soc, small.energy)).length, 0);

  // A 3¼-hour gap in the middle leaves two drops of under 40 points either
  // side, rather than one 95-point drop that would count the missing energy.
  const full = discharge({
    fullPackWh: 4600, fromSoc: 100, toSoc: 5, whPerSlot: 115,
  });
  const slots = buildSlots(full.soc, full.energy);
  const mid = Math.floor(slots.length / 2);
  const gapped = [...slots.slice(0, mid - 6), ...slots.slice(mid + 7)];
  assert.equal(dischargeSegments(slots).length, 1);
  assert.equal(dischargeSegments(gapped).length, 0);
});

test('the median ignores an outlier and needs enough segments', () => {
  const segment = (fullPackWh) => ({ fullPackWh });

  assert.equal(estimateFullPackWh([segment(4500), segment(4600)]), null);
  assert.equal(estimateFullPackWh([segment(4500), segment(4600), segment(9000)]), 4600);
  assert.equal(estimateFullPackWh([segment(4400), segment(4500), segment(4600), segment(9000)]), 4550);
});

test('state of health is a whole percent of rated capacity, capped at 100', () => {
  assert.equal(stateOfHealth(4624, 6400), 72);
  assert.equal(stateOfHealth(7000, 6400), 100);
  assert.equal(stateOfHealth(null, 6400), null);
  assert.equal(stateOfHealth(4624, null), null);
});

test('discharge efficiency is the square root of the lifetime round trip, clamped', () => {
  // The author's site's lifetime totals: 0.962 round trip.
  assert.ok(Math.abs(dischargeEfficiency(18244190, 17556570) - Math.sqrt(17556570 / 18244190)) < 1e-12);
  assert.equal(dischargeEfficiency(1000, 500), 0.85);
  assert.equal(dischargeEfficiency(1000, 1200), 1);
  assert.equal(dischargeEfficiency(undefined, 500), 1);
  assert.equal(dischargeEfficiency(0, 0), 1);
});

test('the efficiency correction lifts the estimate towards the battery\'s own figure', () => {
  // The author's site: median 4,478 Wh against a battery-reported 4,624 Wh (72%).
  const efficiency = dischargeEfficiency(18244190, 17556570);
  assert.equal(stateOfHealth(4478, 6400), 70);
  assert.equal(stateOfHealth(4478, 6400, { efficiency }), 71);
  assert.ok(Math.abs(4478 / efficiency - 4624) / 4624 < 0.015);
});
