// Panel planes: groups of panels facing different ways, each forecast
// separately and weighted by its share of the array. A plane is
// { tilt, azimuth, share, panels? }, tilt in degrees from horizontal and
// azimuth a compass bearing (0 = north, 90 = east, clockwise).
//
// SolarEdge's site layout has a tilt and azimuth per panel, but it's a
// drawing the installer made, not a survey: on the author's site the groups,
// their placement and directions didn't match the roof. So the planes come
// from the owner (the app's settings), with the harness's detect command
// suggesting them from the site's own production.

// Planes from the app's panel group settings: [{ panels, tilt, azimuth }],
// azimuth null meaning "facing the equator" (the forecaster fills it in once
// it knows the latitude). Groups with no panels are left out; when only the
// first group is set, it needn't say how many panels it has. Throws a
// message for the user when the groups don't add up.
export function planesFromGroups(groups) {
  const [first, ...others] = groups;
  const extra = others.filter((group) => group.panels > 0);

  if (!extra.length) {
    return [{ tilt: first.tilt, azimuth: first.azimuth ?? null, share: 1 }];
  }
  if (!(first.panels > 0)) {
    throw new Error('Set how many panels the first group has, so the groups can be weighed against each other.');
  }

  const used = [first, ...extra];
  const total = used.reduce((sum, group) => sum + group.panels, 0);
  return used.map((group) => ({
    tilt: group.tilt,
    azimuth: group.azimuth ?? null,
    panels: group.panels,
    share: group.panels / total,
  }));
}

// "13 × 20°/339°, 9 × 20°/251°", for logs and the harness.
export function describePlanes(planes) {
  return planes.map((p) => `${p.panels ?? `${Math.round(p.share * 100)}%`} × ${p.tilt}°/${p.azimuth === null ? 'equator' : `${Math.round(p.azimuth)}°`}`).join(', ');
}

// Parses "13@20/339,9@20/251" (panels@tilt/azimuth) into planes, for the
// harness's --planes option.
export function parsePlanes(text) {
  const planes = text.split(',').map((part) => {
    const match = part.trim().match(/^(\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (!match) throw new Error(`Can't read plane "${part}": use panels@tilt/azimuth, e.g. 13@20/339`);
    return { panels: Number(match[1]), tilt: Number(match[2]), azimuth: Number(match[3]) % 360 };
  });
  const total = planes.reduce((sum, p) => sum + p.panels, 0);
  return planes.map((p) => ({ ...p, share: p.panels / total }));
}
