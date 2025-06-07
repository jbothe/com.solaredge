import SolarEdgeDriver from '../../lib/SolarEdgeDriver.mjs';

export default class SolarEdgeDriverBattery extends SolarEdgeDriver {

  async onPairFilterSite({ api, site }) {
    const capabilities = await api.getCapabilities({ siteId: site.id });
    return capabilities?.hasStorage === true;
  }

};