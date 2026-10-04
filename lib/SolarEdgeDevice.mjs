import Homey from 'homey';
import SolarEdgeAPI from './SolarEdgeAPI.mjs';

export default class SolarEdgeDevice extends Homey.Device {

  static LONG_POLL_INTERVAL = 1000 * 60 * 15; // 15 mins

  static WATCHDOG_INTERVAL = 1000 * 60; // 1 min

  // 30 missed site polls. Live values are what the device tile shows, so once
  // they stop arriving the device must not keep presenting the last one.
  static LIVE_STALE_AFTER = 1000 * 60 * 5; // 5 mins

  // 4 missed long polls. These feed the cumulative energy meters, which fail
  // independently of the live values because they use a separate session.
  static LONG_POLL_STALE_AFTER = 1000 * 60 * 60; // 1 hour

  // Capabilities older versions put on devices that this one no longer uses.
  // Left in place they show as untitled "Energy" (or similar) tiles stuck on
  // their last value, so they're removed at startup.
  static RETIRED_CAPABILITIES = [];

  async onInit() {
    for (const capability of this.constructor.RETIRED_CAPABILITIES) {
      if (this.hasCapability(capability)) {
        this.log(`Removing retired capability ${capability}`);
        await this.removeCapability(capability);
      }
    }

    // Count startup as fresh, so the watchdog doesn't fire before the first
    // poll of either kind has had a chance to land.
    this.lastLiveUpdate = Date.now();
    this.lastLongPollUpdate = Date.now();
    this.isLiveStale = false;
    this.hasStaleWarning = false;

    // The site's shared session: one login for all its devices.
    this.sitePoller = this.homey.app.getSitePoller(this.getData().siteId);
    this.sitePoller.registerDevice(this);
    this.api = this.sitePoller.api;

    this.longPollInterval = setInterval(() => this.longPoll(), this.constructor.LONG_POLL_INTERVAL);
    this.watchdogInterval = setInterval(() => this.checkStale(), this.constructor.WATCHDOG_INTERVAL);

    this.longPoll();
  }

  // Homey lists capabilities in the order they were added, so devices that
  // gained some at runtime show them out of the manifest's order. This adds
  // any missing ones from `order`, then removes and re-adds everything from
  // the first one out of place onwards, carrying their values across (some,
  // like an estimated SoH, take days to come back otherwise). Capabilities
  // not in `order` are left where they are.
  async orderCapabilities(order) {
    for (const capability of order) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }

    const current = this.getCapabilities().filter((capability) => order.includes(capability));
    const firstOutOfPlace = current.findIndex((capability, i) => capability !== order[i]);
    if (firstOutOfPlace === -1) return;

    const moved = order.slice(firstOutOfPlace);
    this.log(`Reordering capabilities: ${moved.join(', ')}`);

    const values = new Map(moved.map((capability) => [capability, this.getCapabilityValue(capability)]));

    for (const capability of moved) {
      await this.removeCapability(capability);
    }
    for (const capability of moved) {
      await this.addCapability(capability);

      const value = values.get(capability);
      if (value !== null && value !== undefined) {
        await this.setCapabilityValue(capability, value).catch(this.error);
      }
    }
  }

  async onUninit() {
    this.sitePoller?.unregisterDevice(this);

    if (this.longPollInterval) {
      clearInterval(this.longPollInterval);
    }

    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }
  }

  longPoll() {
    this.onLongPoll()
      .then(() => {
        this.lastLongPollUpdate = Date.now();
      })
      .catch((err) => {
        this.error(`Error Long Polling: ${err.message}`);
      });
  }

  // Called by SolarEdgeSitePoller. Freshness is recorded before dispatching:
  // it tracks whether current data is still arriving from SolarEdge, which is
  // exactly what a successful poll proves. A handler that then throws is a
  // separate problem, already logged by the poller.
  async handleSitePowerflow(sitePowerflow) {
    this.markLiveUpdate();
    await this.onSitePowerflow(sitePowerflow);
  }

  // For drivers that source their live values from somewhere other than the
  // site powerflow poll.
  markLiveUpdate() {
    this.lastLiveUpdate = Date.now();
  }

  formatAge(ms) {
    const minutes = Math.floor(ms / 60000);

    if (minutes < 60) {
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours} hour${hours === 1 ? '' : 's'}`;
    }

    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  }

  // Nothing upstream guarantees a failed poll surfaces as an error: a request
  // can hang, or a driver can quietly skip an absent field. Without this the
  // device keeps displaying its last known values as if they were current.
  checkStale() {
    const now = Date.now();

    const liveAge = now - this.lastLiveUpdate;
    if (liveAge > this.constructor.LIVE_STALE_AFTER) {
      if (!this.isLiveStale) {
        this.isLiveStale = true;
        this.error(`No live data for ${this.formatAge(liveAge)}, marking unavailable`);
        this.setUnavailable(`No data received for ${this.formatAge(liveAge)}.`).catch(this.error);
      }
      return;
    }

    this.isLiveStale = false;

    const longPollAge = now - this.lastLongPollUpdate;
    if (longPollAge > this.constructor.LONG_POLL_STALE_AFTER) {
      if (!this.hasStaleWarning) {
        this.hasStaleWarning = true;
        this.error(`Energy totals not updated for ${this.formatAge(longPollAge)}`);
        this.setWarning(`Energy totals last updated ${this.formatAge(longPollAge)} ago.`).catch(this.error);
      }
    } else if (this.hasStaleWarning) {
      this.hasStaleWarning = false;
      this.unsetWarning().catch(this.error);
    }
  }

  async onSitePowerflow(sitePowerflow) {
    // Overload Me
  }

  async onSitePowerflowError(err) {
    this.error(`Error Polling: ${err.message}`);
    await this.setUnavailable(err).catch(this.error);
  }

  async ensureSignedIn() {
    await this.sitePoller.ensureSignedIn();
  }

  async onLongPoll() {
    await this.ensureSignedIn();

    // Overload Me
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      // Checked on a separate instance first, so a mistyped password is
      // refused without breaking the session the site's other devices use.
      const credentials = { username: newSettings.username, password: newSettings.password };
      const check = new SolarEdgeAPI();
      await check.login(credentials);
      this.sitePoller.setCredentials(credentials, check.cookies);

      // The site's other devices store the login too, and whichever starts
      // first after a restart supplies it, so they all get the new one.
      for (const other of this.sitePoller.devices) {
        if (other !== this) await other.setSettings(credentials).catch(this.error);
      }

      this.longPoll();
    }
  }

}
