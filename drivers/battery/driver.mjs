import SolarEdgeDriver from '../../lib/SolarEdgeDriver.mjs';

export default class SolarEdgeDriverBattery extends SolarEdgeDriver {

  onPairFilterSite(site) {
    console.log('site', JSON.stringify(site, false, 2)); // TODO: Figure out how to filter on batteries
    return true;
  }

};