import SolarEdgeDriver from '../../lib/SolarEdgeDriver.mjs';

export default class SolarEdgeDriverInverter extends SolarEdgeDriver {

  async onPairFilterSite({ api, siteId }) {
    const sitePowerflow = await api.getSitePowerflow({ siteId });
    return sitePowerflow?.solarProduction?.isActive === true;
  }

};