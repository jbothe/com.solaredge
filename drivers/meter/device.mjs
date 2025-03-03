import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceMeter extends SolarEdgeDevice {

  async onPoll() {
    await super.onPoll();

    // Get Powerflow
    const sitePowerflow = await this.api.getSitePowerflow({
      siteId: this.getData().siteId,
    });

    if (sitePowerflow.consumption?.currentPower === null) {
      await this.setCapabilityValue('measure_power', 0).catch(this.error);
    } else if (typeof sitePowerflow.consumption?.currentPower === 'number') {
      // TODO: Maybe use sitePowerflow.consumption.isConsuming to flip the sign?
      await this.setCapabilityValue('measure_power', Math.round(sitePowerflow.consumption.currentPower * 1000)).catch(this.error);
    }

    if (sitePowerflow.consumption?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

};