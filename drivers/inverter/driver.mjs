import SolarEdgeDriver from '../../lib/SolarEdgeDriver.mjs';

export default class SolarEdgeDriverInverter extends SolarEdgeDriver {

  async onInit(...props) {
    await super.onInit(...props);

    this.homey.flow
      .getConditionCard('solar_forecast_tomorrow_above')
      .registerRunListener(async ({ device, estimate, kwh }) => {
        const { tomorrow } = device.getForecastSummary();
        return tomorrow[estimate] / 1000 > kwh;
      });

    this.homey.flow
      .getConditionCard('solar_forecast_power_at_above')
      .registerRunListener(async ({ device, time, watts }) => {
        return device.getExpectedPowerAt(time) > watts;
      });
  }

  async onPairFilterSite({ api, site }) {
    const sitePowerflow = await api.getSitePowerflow({ siteId: site.id });
    return sitePowerflow?.solarProduction?.isActive === true;
  }

}
