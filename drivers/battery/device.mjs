import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceBattery extends SolarEdgeDevice {

  async onPoll() {
    await super.onPoll();

    // Get Powerflow
    const sitePowerflow = await this.api.getSitePowerflow({
      siteId: this.getData().siteId,
    });

    if (typeof sitePowerflow.storage?.currentPower === 'number') {
      let power = Math.round(sitePowerflow.storage.currentPower * 1000);

      // Invert the value when discharging
      if (sitePowerflow.storage?.status === 'discharging') {
        power = power * -1;
      }

      await this.setCapabilityValue('measure_power', power).catch(this.error);
    }

    if (typeof sitePowerflow.storage?.chargeLevel === 'number') {
      await this.setCapabilityValue('measure_battery', sitePowerflow.storage.chargeLevel).catch(this.error);
    }

    switch (sitePowerflow.storage?.status) {
      case 'charging': {
        await this.setCapabilityValue('battery_charging_state', 'charging').catch(this.error);
        break;
      }
      case 'discharging': {
        await this.setCapabilityValue('battery_charging_state', 'discharging').catch(this.error);
        break;
      }
      case 'idle': {
        await this.setCapabilityValue('battery_charging_state', 'idle').catch(this.error);
        break;
      }
    }

    if (sitePowerflow.storage?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }
  }

};