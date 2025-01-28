import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceEVCharger extends SolarEdgeDevice {

  async onPoll() {
    await super.onPoll();

    // Get Powerflow
    const sitePowerflow = await this.api.getSitePowerflow({
      siteId: this.getData().siteId,
    });

    this.log('sitePowerflow.evCharger', sitePowerflow.evCharger);

    if (sitePowerflow.evCharger?.currentPower === null) {
      await this.setCapabilityValue('measure_power', 0).catch(this.error);
    } else if (typeof sitePowerflow.evCharger?.currentPower === 'number') {
      await this.setCapabilityValue('measure_power', Math.round(sitePowerflow.evCharger.currentPower * 1000)).catch(this.error);
    }

    switch (sitePowerflow.evCharger?.connectionStatus) {
      case 'disconnected': {
        // TODO
        break;
      }
      case 'connected': {
        // TODO
        break;
      }
      // TODO
    }

    if (sitePowerflow.evCharger?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

};