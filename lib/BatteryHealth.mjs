// Battery state of health, estimated from how much energy the battery
// delivers per percent of state of charge it loses. SolarEdge used to report
// the battery's own full-pack energy (V1 storageData), but that API is gone
// and nothing a homeowner login reaches exposes it.
//
// For each stretch where the state of charge only falls by at least
// MIN_SOC_DROP points, full pack ≈ energy discharged × 100 / points lost. The
// median over many stretches is compared with the rated capacity.
//
// Some of the energy that leaves the cells never shows up as delivered
// (internal resistance, BMS and thermal management), so that alone reads
// low. The lifetime ratio of energy discharged to charged is the round trip's
// efficiency; assuming the losses split evenly between charging and
// discharging, the discharge side is its square root, and the estimate is
// divided by that. Lifetime totals are used because a recent ratio swings
// with usage and season (standby draw weighs more on quiet days), which would
// show up as health changes that aren't there.
//
// Checked against the author's site while V1 still answered, against the battery's
// own 4,624 Wh (72.3% of 6.4 kWh): 20 stretches over 10 days gave a median of
// 4,478 Wh (−3.2%), and 4,565 Wh (−1.3%) after the correction. Dividing by
// the whole round-trip ratio overshot (+0.6%), and by a 30-day ratio more so
// (+1.8%). It's for spotting a trend, not an exact figure.
//
// Only discharge is used: charging includes grid charging, which SolarEdge
// doesn't break out per interval, and charging losses would inflate it.

// Smaller drops let the 1% resolution of the state of charge dominate.
export const MIN_SOC_DROP = 40;

// Too few stretches and one odd day decides the result.
export const MIN_SEGMENTS = 3;

const SLOT_MS = 15 * 60 * 1000;

// Joins the 5-minute state of charge samples onto the 15-minute energy slots.
// Returns [{ time, soc, dischargeWh }] for slots with both, sorted by time,
// where dischargeWh is the energy the battery supplied during the slot that
// starts at time.
export function buildSlots(socMeasurements, energyMeasurements) {
  const socByTime = new Map(socMeasurements
    .filter((m) => typeof m.stateOfCharge === 'number')
    .map((m) => [Date.parse(m.measurementTime), m.stateOfCharge]));

  return energyMeasurements
    .map((m) => ({
      time: Date.parse(m.measurementTime),
      soc: socByTime.get(Date.parse(m.measurementTime)),
      dischargeWh: m.consumptionDistribution?.consumptionFromBattery,
    }))
    .filter((slot) => typeof slot.soc === 'number' && typeof slot.dischargeWh === 'number')
    .sort((a, b) => a.time - b.time);
}

// [{ start, end, socDrop, dischargedWh, fullPackWh }] for each run of
// consecutive slots over which the state of charge never rises and falls by
// at least minDrop points in all. A gap in the data ends a run.
export function dischargeSegments(slots, { minDrop = MIN_SOC_DROP } = {}) {
  const segments = [];
  let i = 0;

  while (i < slots.length - 1) {
    let j = i;
    while (j + 1 < slots.length
      && slots[j + 1].time - slots[j].time === SLOT_MS
      && slots[j + 1].soc <= slots[j].soc) {
      j += 1;
    }

    const socDrop = slots[i].soc - slots[j].soc;
    if (socDrop >= minDrop) {
      // The state of charge is sampled at the start of each slot, so the
      // energy that took it from slots[i] to slots[j] is in slots i..j-1.
      let dischargedWh = 0;
      for (let k = i; k < j; k += 1) dischargedWh += slots[k].dischargeWh;

      segments.push({
        start: new Date(slots[i].time).toISOString(),
        end: new Date(slots[j].time).toISOString(),
        socDrop,
        dischargedWh: Math.round(dischargedWh),
        fullPackWh: Math.round((dischargedWh * 100) / socDrop),
      });
    }

    i = Math.max(j, i + 1);
  }

  return segments;
}

// Median full-pack energy over the segments, or null with too few of them.
export function estimateFullPackWh(segments, { minSegments = MIN_SEGMENTS } = {}) {
  if (segments.length < minSegments) return null;

  const sorted = segments.map((s) => s.fullPackWh).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Discharge-side efficiency from lifetime energy charged and discharged: the
// square root of the round trip. Clamped, since a ratio outside this range
// says more about the meters (or a battery swap) than about losses. 1 when
// the totals are missing.
export const MIN_DISCHARGE_EFFICIENCY = 0.85;

export function dischargeEfficiency(chargedWh, dischargedWh) {
  if (!(chargedWh > 0) || !(dischargedWh > 0)) return 1;
  return Math.min(1, Math.max(MIN_DISCHARGE_EFFICIENCY, Math.sqrt(dischargedWh / chargedWh)));
}

// State of health in whole percent of the rated capacity, capped at 100.
// efficiency (from dischargeEfficiency) adds back the energy lost inside the
// battery while discharging.
export function stateOfHealth(fullPackWh, ratedWh, { efficiency = 1 } = {}) {
  if (!(fullPackWh > 0) || !(ratedWh > 0)) return null;
  return Math.min(100, Math.round((100 * fullPackWh) / efficiency / ratedWh));
}
