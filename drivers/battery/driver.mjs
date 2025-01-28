import SolarEdgeDriver from '../../lib/SolarEdgeDriver.mjs';

export default class SolarEdgeDriverBattery extends SolarEdgeDriver {

  async onPairFilterSite({ api, siteId }) {
    const sitePowerflow = await api.getSitePowerflow({ siteId });
    return sitePowerflow?.storage?.isActive === true;
  }

};