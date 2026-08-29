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

  async onInit() {
    this.api = new SolarEdgeAPI(this.homey.clock.getTimezone());

    // Count startup as fresh, so the watchdog doesn't fire before the first
    // poll of either kind has had a chance to land.
    this.lastLiveUpdate = Date.now();
    this.lastLongPollUpdate = Date.now();
    this.isLiveStale = false;
    this.hasStaleWarning = false;

    this.sitePoller = this.homey.app.getSitePoller(this.getData().siteId);
    this.sitePoller.registerDevice(this);

    this.longPollInterval = setInterval(() => this.longPoll(), this.constructor.LONG_POLL_INTERVAL);
    this.watchdogInterval = setInterval(() => this.checkStale(), this.constructor.WATCHDOG_INTERVAL);

    this.longPoll();
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
    if (!this.api.isLoggedIn()) {
      await this.api.login({
        username: this.getSettings().username,
        password: this.getSettings().password,
      });
    }
  }

  async onLongPoll() {
    await this.ensureSignedIn();

    // Overload Me
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('username') || changedKeys.includes('password')) {
      await this.api.login({
        username: newSettings.username,
        password: newSettings.password,
      });

      this.sitePoller?.invalidateSession(this);

      this.longPoll();
    }

    if (changedKeys.includes('apikey')) {
      await this.api.getOldSites({ apikey: newSettings.apikey });
      this.longPoll();
    }
  }

}
