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

    // Get measurements for each previous year
    const measurements = {};
    const currentYear = new Date().getFullYear();
    let previousYear = currentYear;
    while (true) {
      try {
        previousYear--;

        let storedResult = await this.getStoreValue(`measurements-${previousYear}`);
        if (storedResult === null) {
          this.log(`Fetching measurements for ${previousYear}...`);
          const result = await this.api.getSiteMeasurements({
            siteId: this.getData().siteId,
            startDate: `${previousYear}-01-01`,
            endDate: `${previousYear}-12-31`,
          }).then(result => ({
            imported: result.summary.import,
            exported: result.summary.export,
          }));

          await this.setStoreValue(`measurements-${previousYear}`, result);
          storedResult = result;
        }

        if (storedResult.imported === null && storedResult.exported === null) break;

        measurements[previousYear] = storedResult;

      } catch (err) {
        console.error(err);
      }
    }

    // Get live measurement for this year
    measurements[currentYear] = await this.api.getSiteMeasurements({
      siteId: this.getData().siteId,
      startDate: `${currentYear}-01-01`,
      endDate: `${currentYear}-12-31`,
    }).then(result => ({
      imported: result.summary.import,
      exported: result.summary.export,
    }));

    let totalImported = 0;
    let totalExported = 0;
    for (const year in measurements) {
      totalImported += measurements[year].imported;
      totalExported += measurements[year].exported;
    }

    const energyObject = await this.getEnergy();

    // TODO: Remove this in April
    if (!this.hasCapability('meter_power.imported')) {
      await this.addCapability('meter_power.imported');
    }

    // TODO: Remove this in April
    if (!energyObject.cumulativeImportedCapability) {
      await this.setEnergy({
        ...energyObject,
        cumulativeImportedCapability: 'meter_power.imported',
      });
    }

    await this.setCapabilityValue('meter_power.imported', Math.round(totalImported / 1000)).catch(this.error);

    // TODO: Remove this in April
    if (!this.hasCapability('meter_power.exported')) {
      await this.addCapability('meter_power.exported');
    }

    // TODO: Remove this in April
    if (!energyObject.cumulativeExportedCapability) {
      await this.setEnergy({
        ...energyObject,
        cumulativeExportedCapability: 'meter_power.exported',
      });
    }

    await this.setCapabilityValue('meter_power.exported', Math.round(totalExported / 1000)).catch(this.error);
  }

};