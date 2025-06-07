import SolarEdgeDriver from '../../lib/SolarEdgeDriver.mjs';

export default class SolarEdgeDriverInverter extends SolarEdgeDriver {

  async onPairFilterSite({ api, site }) {
    const capabilities = await api.getCapabilities({ siteId: site.id });
    return capabilities?.hasStorage === true;
  }

};