import SolarEdgeDriver from '../../lib/SolarEdgeDriver.mjs';

export default class SolarEdgeDriverMeter extends SolarEdgeDriver {

  async onPairFilterSite({ api, site }) {
    const sitePowerflow = await api.getSitePowerflow({ siteId: site.id });
    return sitePowerflow?.consumption?.isActive === true;
  }

};