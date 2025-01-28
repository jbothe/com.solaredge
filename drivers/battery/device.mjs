import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceBattery extends SolarEdgeDevice {

  async onPoll() {
    await super.onPoll();

    // Get Powerflow
    const sitePowerflow = await this.api.getSitePowerflow({
      siteId: this.getData().siteId,
    });

    if (typeof sitePowerflow.storage?.currentPower === 'number') {
      await this.setCapabilityValue('measure_power', Math.round(sitePowerflow.storage.currentPower * 1000)).catch(this.error);
    }

    if (typeof sitePowerflow.storage?.chargeLevel === 'number') {
      await this.setCapabilityValue('measure_battery', sitePowerflow.storage.chargeLevel).catch(this.error);
    }

    switch (sitePowerflow.storage?.status) {
      case 'charging': {
        await this.setCapabilityValue('battery_charging_state', 'charging').catch(this.error);
        break;
      }
      case 'discharging': { // TODO: Verify
        await this.setCapabilityValue('battery_charging_state', 'discharging').catch(this.error);
        break;
      }
      case 'idle': { // TODO: Verify
        await this.setCapabilityValue('battery_charging_state', 'idle').catch(this.error);
        break;
      }
    }
  }

};