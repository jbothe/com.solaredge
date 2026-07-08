import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceEVCharger extends SolarEdgeDevice {

  static POLL_INTERVAL = 1000 * 10; // 10 seconds

  async onInit() {
    // This driver doesn't consume site powerflow data (it polls
    // getSiteDevices instead), so it runs its own interval alongside the
    // base class's long-poll rather than registering with the site poller.
    await super.onInit();

    this.registerCapabilityListener('solaredge-home-load-controller-state', async (value) => {
      await this.onCapabilityState(value);
    });

    this.pollInterval = setInterval(() => this.poll(), this.constructor.POLL_INTERVAL);
    this.poll();
  }

  async onUninit() {
    await super.onUninit();

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  poll() {
    this.onPoll().catch(err => {
      this.error(`Error Polling: ${err.message}`);
      this.setUnavailable(err).catch(this.error);
    });
  }

  async onCapabilityState(value) {
    const {
      siteId,
      reporterId,
    } = this.getData();

    // Calculate State
    const state = {};

    switch (value) {
      case 'on': {
        state.level = 100;
        state.mode = 'MANUAL';
        break;
      }
      case 'off': {
        state.level = 0;
        state.mode = 'MANUAL';
        break;
      }
      case 'auto': {
        state.mode = 'AUTO';
        state.level = null;
        state.duration = null;
        break;
      }
    }

    // Set State
    await this.api.setSiteDeviceApplianceActivationState({
      siteId,
      reporterId,
      state,
    });
  }

  async onPoll() {
    await this.ensureSignedIn();

    const {
      siteId,
      reporterId,
    } = this.getData();

    const { devices } = await this.api.getSiteDevices({
      siteId,
    });

    const device = devices.find(device => device.reporterId === reporterId);
    if (!device) {
      throw new Error(`Device Not Found`);
    }

    switch (device.activationMode) {
      case 'MANUAL': {
        switch (device.status.level) {
          case 0: {
            await this.setCapabilityValue('solaredge-home-load-controller-state', 'off');
            break;
          }
          case 100: {
            await this.setCapabilityValue('solaredge-home-load-controller-state', 'on');
            break;
          }
        }
        break;
      }
      case 'AUTO': {
        await this.setCapabilityValue('solaredge-home-load-controller-state', 'auto');
        break;
      }
    }

    // Availability
    if (device.deviceStatus === 'ACTIVE') {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

};