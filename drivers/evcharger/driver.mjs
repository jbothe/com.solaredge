import SolarEdgeDriver from '../../lib/SolarEdgeDriver.mjs';

export default class SolarEdgeDriverEVCharger extends SolarEdgeDriver {

  async onPairListDevices({ api, site }) {
    const siteDevices = await api.getSiteDevices({
      siteId: site.id,
    });

    const evChargers = siteDevices.devicesByType.EV_CHARGER ?? [];
    return evChargers.map(device => ({
      name: device.name,
      data: {
        reporterId: device.reporterId,
        serialNumber: device.serialNumber,
      },
    }));
  }

};