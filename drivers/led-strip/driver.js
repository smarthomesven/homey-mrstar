'use strict';

const Homey = require('homey');

const SERVICE_UUID = '0000fff000001000800000805f9b34fb';

const ADVERTISED_NAME = 'GATT--DEMO';

module.exports = class MrStarDriver extends Homey.Driver {

  async onInit() {
    this.log('MR Star driver initialized');
  }

  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover([], 8000);

    const matches = advertisements.filter((adv) => {
      if (adv.localName && adv.localName.includes(ADVERTISED_NAME)) return true;
      if (adv.serviceUuids && adv.serviceUuids.includes(SERVICE_UUID)) return true;
      return false;
    });

    return matches.map((adv) => ({
      name: adv.localName || 'LED Strip',
      data: {
        id: adv.uuid,
      },
      store: {
        address: adv.address,
      },
    }));
  }

};