import net from 'node:net';

import Homey from 'homey';
import SolarEdgeSitePoller from './lib/SolarEdgeSitePoller.mjs';

export default class SolarEdgeApp extends Homey.App {

  // When a host has both IPv6 and IPv4 addresses, Node tries each for only
  // 250 ms before moving on. Open-Meteo's history servers are in Germany,
  // 350 ms from Australia, so on a Homey that has an IPv6 address but no
  // IPv6 route every attempt was cut short and requests failed with
  // ETIMEDOUT (and an empty message) after about 270 ms.
  static CONNECT_ATTEMPT_TIMEOUT = 2500;

  async onInit() {
    if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
      net.setDefaultAutoSelectFamilyAttemptTimeout(SolarEdgeApp.CONNECT_ATTEMPT_TIMEOUT);
    }

    this.sitePollers = new Map();
  }

  getSitePoller(siteId) {
    if (!this.sitePollers.has(siteId)) {
      this.sitePollers.set(siteId, new SolarEdgeSitePoller(this.homey, siteId));
    }
    return this.sitePollers.get(siteId);
  }

}
