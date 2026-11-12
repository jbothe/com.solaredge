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

// Panel planes: groups of panels facing different ways, each forecast
// separately and weighted by its share of the array. A plane is
// { tilt, azimuth, share, panels? }, tilt in degrees from horizontal and
// azimuth a compass bearing (0 = north, 90 = east, clockwise).
//
// SolarEdge's site layout has a tilt and azimuth per panel, but it's a
// drawing the installer made, not a survey: on the author's site the groups,
// their placement and directions didn't match the roof. So the planes come
// from the owner (the inverter's settings).

// Planes from the app's panel group settings: [{ panels, tilt, azimuth }],
// azimuth null meaning "facing the equator" (the forecaster fills it in once
// it knows the latitude). Groups with no panels are left out; when only the
// first group is set, it needn't say how many panels it has. Throws a
// message for the user when the groups don't add up.
function planesFromGroups(groups) {
  const [first, ...others] = groups;
  const extra = others.filter((group) => group.panels > 0);

  if (!extra.length) {
    return [{ tilt: first.tilt, azimuth: first.azimuth ?? null, share: 1 }];
  }
  if (!(first.panels > 0)) {
    // worded for the user by the device (errors.forecastFirstGroup)
    throw Object.assign(new Error('Set how many panels the first group has, so the groups can be weighed against each other.'), { code: 'FORECAST_FIRST_GROUP' });
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

// "13 × 20°/339°, 9 × 20°/251°", for the log.
function describePlanes(planes) {
  return planes.map((p) => `${p.panels ?? `${Math.round(p.share * 100)}%`} × ${p.tilt}°/${p.azimuth === null ? 'equator' : `${Math.round(p.azimuth)}°`}`).join(', ');
}

module.exports = {
  planesFromGroups,
  describePlanes,
};
