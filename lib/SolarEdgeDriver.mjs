import Homey from 'homey';
import SolarEdgeAPI from './SolarEdgeAPI.mjs';

export default class SolarEdgeDriver extends Homey.Driver {

  async onPair(session) {
    const api = new SolarEdgeAPI();
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
      return sites.map(site => ({
        name: site.name,
        data: {
          siteId: site.id,
        },
        settings: {
          username,
          password,
        },
      }));
    });
  }

};
