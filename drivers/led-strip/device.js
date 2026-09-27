'use strict';

const Homey = require('homey');

const SERVICE_UUID = '0000fff000001000800000805f9b34fb';
const CHAR_WRITE_UUID = '0000fff300001000800000805f9b34fb';
const CHAR_NOTIFY_UUID = '0000fff400001000800000805f9b34fb';

const START_BYTE = 0xBC;
const END_BYTE = 0x55;

const CMD_POWER = 0x01;
const CMD_COLOR = 0x04;
const CMD_BRIGHTNESS = 0x05;

const IDLE_DISCONNECT_MS = 3000;

module.exports = class MrStarDevice extends Homey.Device {

  async onInit() {
    this.peripheral = null;

    this._writeQueue = Promise.resolve();

    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
    this.registerMultipleCapabilityListener(
      ['light_hue', 'light_saturation'],
      this.onCapabilityLight.bind(this),
      500,
    );

    this.setAvailable().catch(this.error);
  }

  async onDeleted() {
    if (this._idleDisconnectTimeout) {
      this.homey.clearTimeout(this._idleDisconnectTimeout);
    }
    await this._disconnect();
  }

  // ---------------------------------------------------------------------
  // Connect-on-demand: only hold a connection while actively writing, so
  // the controller (which seems to allow only one BLE connection at a
  // time) stays available to the mobile app the rest of the time.
  // ---------------------------------------------------------------------

  async _ensureConnected() {
    // Cancel any pending idle-disconnect — we're using the connection again.
    if (this._idleDisconnectTimeout) {
      this.homey.clearTimeout(this._idleDisconnectTimeout);
      this._idleDisconnectTimeout = null;
    }

    if (this.peripheral && this.peripheral.isConnected) {
      return this.peripheral;
    }

    const { id } = this.getData();
    const advertisement = await this.homey.ble.find(id);
    this.peripheral = await advertisement.connect();

    try {
      const services = await this.peripheral.discoverServices();
      const service = services.find((s) => s.uuid === SERVICE_UUID);
      if (service) {
        const characteristics = await service.discoverCharacteristics([CHAR_NOTIFY_UUID]);
        const notifyChar = characteristics.find((c) => c.uuid === CHAR_NOTIFY_UUID);
        if (notifyChar) {
          await notifyChar.subscribeToNotifications(() => {});
        }
      }
    } catch (err) {
      this.log('Could not warm up link via notify subscribe:', err.message);
    }

    return this.peripheral;
  }

  _scheduleIdleDisconnect() {
    if (this._idleDisconnectTimeout) {
      this.homey.clearTimeout(this._idleDisconnectTimeout);
    }
    this._idleDisconnectTimeout = this.homey.setTimeout(() => {
      this._idleDisconnectTimeout = null;
      this._disconnect().catch(this.error);
    }, IDLE_DISCONNECT_MS);
  }

  async _disconnect() {
    if (this.peripheral) {
      try {
        await this.peripheral.disconnect();
      } catch (err) {
        // already disconnected — ignore
      }
    }
    this.peripheral = null;
  }


  async onCapabilityOnoff(value) {
    const state = value ? 0x01 : 0x00;
    await this.sendPacket([CMD_POWER, 0x01, state]);
  }

  async onCapabilityDim(value) {
    let raw = Math.round(value * 1000);
    if (raw < 3) raw = 3;
    await this.sendPacket([
      CMD_BRIGHTNESS, 0x06,
      (raw >> 8) & 0xFF, raw & 0xFF,
      0x00, 0x00, 0x00, 0x00,
    ]);
  }

  async onCapabilityLight(newValues) {
    const hue = newValues.light_hue !== undefined
      ? newValues.light_hue
      : this.getCapabilityValue('light_hue') || 0;
    const saturation = newValues.light_saturation !== undefined
      ? newValues.light_saturation
      : this.getCapabilityValue('light_saturation') || 0;

    const hueDeg = Math.round(hue * 360);
    const satRaw = Math.round(saturation * 1000);

    const payload = [
      CMD_COLOR, 0x06,
      (hueDeg >> 8) & 0xFF, hueDeg & 0xFF,
      (satRaw >> 8) & 0xFF, satRaw & 0xFF,
      0x00, 0x00,
    ];

    await this.sendPacket(payload);
  }

  /**
   * Wraps a command payload with the start/end framing bytes and writes it,
   * queued so concurrent capability changes (e.g. a quick hue+brightness
   * combo) don't interleave on the wire.
   * @param {number[]} payload - [cmd, len, ...params] (without start/end bytes)
   */
  sendPacket(payload) {
    const packet = Buffer.from([START_BYTE, ...payload, END_BYTE]);

    this._writeQueue = this._writeQueue
      .then(() => this._writeRaw(packet))
      .catch((err) => this.error('BLE write failed:', err.message));

    return this._writeQueue;
  }

  async _writeRaw(packet) {
    await this._ensureConnected();
    try {
      await this.peripheral.write(SERVICE_UUID, CHAR_WRITE_UUID, packet);
    } catch (err) {
      // Connection may have dropped between _ensureConnected() and the
      // write itself - reconnect once and retry before giving up.
      this.log('Write failed, reconnecting and retrying:', err.message);
      this.peripheral = null;
      await this._ensureConnected();
      await this.peripheral.write(SERVICE_UUID, CHAR_WRITE_UUID, packet);
    } finally {
      this._scheduleIdleDisconnect();
    }
  }

};