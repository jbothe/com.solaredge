import Homey from 'homey';
import SolarEdgeSitePoller from './lib/SolarEdgeSitePoller.mjs';

export default class SolarEdgeApp extends Homey.App {

  async onInit() {
    this.sitePollers = new Map();
  }

  getSitePoller(siteId) {
    if (!this.sitePollers.has(siteId)) {
      this.sitePollers.set(siteId, new SolarEdgeSitePoller(this.homey, siteId));
    }
    return this.sitePollers.get(siteId);
  }

}
