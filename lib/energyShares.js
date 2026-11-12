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

// Self-consumption and self-sufficiency for a period, from SolarEdge's energy
// summary with distributions (SolarEdgeCloudClient#getSiteEnergyChart with the
// *-distribution-with-storage, or -without-storage, measurement types) and the
// battery's energy sources over the same period (getSiteStorageDistribution).
//
//   self-consumption  share of the solar produced that the site used, at
//                     home or into the battery, rather than exported
//   self-sufficiency  share of consumption that came from solar: direct, or
//                     from the battery in proportion to how much of what
//                     charged it was solar
//
// Battery energy that was charged from the grid isn't counted as
// self-sufficient: on a site that charges off-peak (the author's site charges
// 85% of its battery from the grid), counting it would show 44% where solar
// covered 16%.
//
// Without distributions (sites without consumption metering, say), falls
// back to production less export, and consumption less import.

function energyShares(summary, batterySources) {
  const production = summary?.production;
  const consumption = summary?.consumption;
  const pd = summary?.productionDistribution;
  const cd = summary?.consumptionDistribution;

  let selfConsumption = null;
  if (production > 0) {
    const used = pd ? (pd.productionToHome ?? 0) + (pd.productionToBattery ?? 0) : production - (summary.export ?? 0);
    selfConsumption = used / production;
  }

  let selfSufficiency = null;
  if (consumption > 0) {
    let fromSolar;
    if (cd) {
      const solarShareOfBattery = batterySources?.total > 0 ? (batterySources.pv ?? 0) / batterySources.total : 0;
      fromSolar = (cd.consumptionFromSolar ?? 0) + (cd.consumptionFromBattery ?? 0) * solarShareOfBattery;
    } else {
      fromSolar = consumption - (summary.import ?? 0);
    }
    selfSufficiency = fromSolar / consumption;
  }

  const clamp = (share) => (share === null ? null : Math.min(1, Math.max(0, share)));
  return { selfConsumption: clamp(selfConsumption), selfSufficiency: clamp(selfSufficiency) };
}

module.exports = energyShares;
