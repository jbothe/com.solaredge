import SolarEdgeDevice from '../../lib/SolarEdgeDevice.mjs';

export default class SolarEdgeDeviceEVCharger extends SolarEdgeDevice {

  async onPoll() {
    await super.onPoll();

    const {
      siteId,
      reporterId,
    } = this.getData();

    // Get Powerflow
    const sitePowerflow = await this.api.getSitePowerflow({ siteId });

    // Set measure_power
    if (sitePowerflow.evCharger?.currentPower === null) {
      await this.setCapabilityValue('measure_power', 0).catch(this.error);
    } else if (typeof sitePowerflow.evCharger?.currentPower === 'number') {
      await this.setCapabilityValue('measure_power', Math.round(sitePowerflow.evCharger.currentPower * 1000)).catch(this.error);
    }


    // Set evcharger_charging_state
    if (sitePowerflow.evCharger?.connectionStatus) {
      if (!this.hasCapability('evcharger_charging_state')) {
        await this.addCapability('evcharger_charging_state');
      }

      switch (sitePowerflow.evCharger?.connectionStatus) {
        case 'connected': {
          await this.setCapabilityValue('evcharger_charging_state', 'plugged_in').catch(this.error);
          break;
        }
        case 'charging': {
          await this.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging').catch(this.error);
          break;
        }
        case 'disconnected': {
          await this.setCapabilityValue('evcharger_charging_state', 'plugged_out').catch(this.error);
          break;
        }
        default: {
          this.log('Unknown EV Charger connection status', sitePowerflow.evCharger?.connectionStatus);
          await this.setCapabilityValue('evcharger_charging_state', null).catch(this.error);
          break;
        }
      }
    }

    // Availability
    if (sitePowerflow.evCharger?.isActive) {
      await this.setAvailable();
    } else {
      await this.setUnavailable();
    }

    // Get Appliance Sessions History
    if (reporterId) {
      const applianceSessionsHistory = await this.api.getSiteDeviceApplianceSessionsHistory({
        siteId: this.getData().siteId,
        reporterId: this.getData().reporterId,
      });

      let totalCharged = 0;
      let totalDischarged = 0;
      applianceSessionsHistory.applianceDetails.forEach(applianceDetails => {
        const statisticsConsumedEnergy = applianceDetails.statistics.find(statistic => statistic.subjectEnum === 'CONSUMED_ENERGY');
        if (typeof statisticsConsumedEnergy?.totalValue === 'number') {
          totalCharged += statisticsConsumedEnergy.totalValue;
        }
      });

      // Set Total Charged
      if (!this.hasCapability('meter_power.charged')) {
        await this.addCapability('meter_power.charged');
      }
      await this.setCapabilityValue('meter_power.charged', totalCharged / 1000).catch(this.error);

      // Set Total Discharged
      if (!this.hasCapability('meter_power.discharged')) {
        await this.addCapability('meter_power.discharged');
      }
      await this.setCapabilityValue('meter_power.discharged', totalDischarged / 1000).catch(this.error);
    } else {
      await this.setWarning('Please remove & re-add this device to get kWh values.');
    }

  }

};