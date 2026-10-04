// Self-consumption and self-sufficiency for a period, from SolarEdge's energy
// summary with distributions (SolarEdgeAPI.getSiteEnergy with the
// *-distribution-with-storage measurement types) and the battery's energy
// sources over the same period (getStorageEnergyDistribution).
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

export default function energyShares(summary, batterySources) {
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
