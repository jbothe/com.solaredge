import Homey from 'homey';
import SolarEdgeAPI from './SolarEdgeAPI.mjs';

export default class SolarEdgeDriver extends Homey.Driver {

  async onPair(session) {
    const api = new SolarEdgeAPI(this.homey.clock.getTimezone());
    let username;
    let password;

    session.setHandler('login', async data => {
      username = data.username;
      password = data.password;

      try {
        await api.login({
          username,
          password,
        });
        return true;
      } catch (err) {
        return false;
      }
    });

    session.setHandler('list_devices', async () => {
      const sites = await api.getSites();
      const result = [];

      for (const site of Object.values(sites)) {
        const devices = await this.onPairListDevices({ api, site });
        for (const device of devices) {
          result.push({
            ...device,
            data: {
              ...device.data,
              siteId: site.id,
            },
            settings: {
              ...device.settings,
              username,
              password,
            },
          });
        }
      }

      return result;
    });
  }

  async onPairListDevices({ api, site }) {
    if (await this.onPairFilterSite({ api, site }) === false) return [];

    return [{
      name: `${site.name} — ${this.homey.__(this.manifest.name)}`,
      data: {},
      settings: {},
    }];
  }

  async onPairFilterSite({ api, site }) {
    return false; // Overload me
  }

};
