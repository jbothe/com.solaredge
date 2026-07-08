import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceBattery extends SolarEdgeDevice {

  async onSitePowerflow(sitePowerflow) {
    if (typeof sitePowerflow.storage?.currentPower === 'number') {
      let power = Math.round(sitePowerflow.storage.currentPower * 1000);

      // Invert the value when discharging
      if (sitePowerflow.storage?.status === 'discharging') {
        power = power * -1;
      }

      await this.setCapabilityValue('measure_power', power).catch(this.error);
    }

    if (typeof sitePowerflow.storage?.chargeLevel === 'number') {
      const soc = Math.round(sitePowerflow.storage?.chargeLevel);
      await this.setCapabilityValue('measure_battery', soc).catch(this.error);
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

  async onLongPoll() {
    // Get Storage
    const siteStorage = await this.api.getSiteStorage({
      apikey: this.getSettings().apikey,
      siteId: this.getData().siteId,
    });

    if (siteStorage.batteries && siteStorage.batteries.length > 0) {
      const battery = siteStorage.batteries[0]
      const totalStorage = battery.nameplate

      if (battery.telemetries.length > 0) {
        const latestTelemetry = battery.telemetries[battery.telemetries.length - 1];

        const temp = latestTelemetry.internalTemp
        if (typeof temp === 'number') {
          await this.setCapabilityValue('measure_temperature', temp).catch(this.error);
        }

        if (typeof latestTelemetry.fullPackEnergyAvailable ==='number' && typeof totalStorage === 'number') {
          const soh = Math.round(100 * latestTelemetry.fullPackEnergyAvailable / totalStorage)
          await this.setCapabilityValue('battery_soh', soh).catch(this.error);
        }

        let lifetimeCharged = latestTelemetry.lifeTimeEnergyCharged
        if (typeof lifetimeCharged === 'number') {
          lifetimeCharged = Math.round(lifetimeCharged / 1000)
          if (!this.hasCapability('meter_power.charged_total')) {
            await this.addCapability('meter_power.charged_total');
          }
          await this.setCapabilityValue('meter_power.charged_total', lifetimeCharged).catch(this.error);
        }

        let lifetimeDischarged = latestTelemetry.lifeTimeEnergyDischarged
        if (typeof lifetimeDischarged === 'number') {
          lifetimeDischarged = Math.round(lifetimeDischarged / 1000)
          if (!this.hasCapability('meter_power.discharged_total')) {
            await this.addCapability('meter_power.discharged_total');
          }
          await this.setCapabilityValue('meter_power.discharged_total', lifetimeDischarged).catch(this.error);
        }
      }
    }
  }

};