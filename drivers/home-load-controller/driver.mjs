import SolarEdgeDriver from '../../lib/SolarEdgeDriver.mjs';

export default class SolarEdgeDriverEVCharger extends SolarEdgeDriver {

  async onInit(...props) {
    await super.onInit(...props);

    this.homey.flow
      .getActionCard('home-load-controller-set-state')
      .registerRunListener(async ({ device, state }) => {
        await device.triggerCapabilityListener('solaredge-home-load-controller-state', state);
      });
  }

  async onPairListDevices({ api, site }) {
    const { devices } = await api.getSiteDevices({
      siteId: site.id,
    });

    return devices
      .filter(device => device.type === 'ON_OFF')
      .map(device => ({
        name: device.name,
        data: {
          reporterId: device.reporterId,
          serialNumber: device.serialNumber,
        },
      }));
  }

};