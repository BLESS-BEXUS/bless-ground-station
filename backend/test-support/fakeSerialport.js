/**
 * Test helper: replaces the "serialport" package with a fake T-HaLow module so the
 * real backend (src/index.ts) can be exercised without hardware.
 *
 *   node -r test-support/fakeSerialport.js -r ts-node/register src/index.ts
 *
 * Behaviour is steered through files in $FAKE_SERIAL_DIR (polled every 40 ms):
 *   unplugged        exists -> the port is "not there": open fails, an open port closes
 *   frames           exists -> a telemetry frame every $FAKE_FRAME_MS (default 250)
 *                    optional JSON content: {"rssi": -72, "fix": true}
 *   inject-*.hex     raw bytes (hex) emitted once, then the file is deleted
 *   received.log     every AT command the backend wrote (appended)
 * AT behaviour: TX_MCS=5 stays silent, TXPOWER=19 answers ERROR, anything else OK.
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const DIR = process.env.FAKE_SERIAL_DIR;
const FRAME_MS = Number(process.env.FAKE_FRAME_MS || 250);
const has = (name) => fs.existsSync(path.join(DIR, name));

function crc16(buf, n) {
  let crc = 0xffff;
  for (let i = 0; i < n; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

function telemetry(count, { rssi = -65, fix = true } = {}) {
  const b = Buffer.alloc(53);
  b.writeUInt16LE(0xb1e5, 0);
  b.writeUInt32LE(count * 1000, 2);
  b.writeUInt32LE(count, 6);
  b.writeInt32LE(Math.round((67.889 + count * 0.0002) * 1e7), 10);
  b.writeInt32LE(Math.round((21.0837 + count * 0.0003) * 1e7), 14);
  b.writeUInt16LE(333 + count, 18);
  b.writeUInt8(fix ? 0x4c : 0x0c, 20);
  b.writeInt16LE(rssi, 21);
  b.writeInt8(20, 23);
  b.writeUInt8(100, 26);
  b.writeUInt16LE(2, 30);
  b.writeUInt16LE(173, 32);
  b.writeUInt32LE(97100, 38);
  b.writeUInt16LE(crc16(b, 51), 51);
  return b;
}

global.__fakeFrameCount = 0;
global.__fakeOpen = null;

class FakeSerialPort extends EventEmitter {
  constructor(opts) {
    super();
    this.path = opts.path;
    this.isOpen = false;
    setTimeout(() => this.tryOpen(), 20);
  }

  tryOpen() {
    if (has("unplugged")) {
      this.emit("error", new Error(`Opening ${this.path}: File not found`));
      return;
    }
    if (global.__fakeOpen && global.__fakeOpen !== this) {
      this.emit("error", new Error(`Opening ${this.path}: Access denied`));
      return;
    }
    global.__fakeOpen = this;
    this.isOpen = true;
    this.emit("open");

    let lastFrame = 0;
    this.watch = setInterval(() => {
      if (!this.isOpen) return;
      if (has("unplugged")) {
        this.shutdown();
        this.emit("close", { disconnected: true });
        return;
      }
      for (const name of fs.readdirSync(DIR)) {
        if (!/^inject-.*\.hex$/.test(name)) continue;
        const file = path.join(DIR, name);
        const hex = fs.readFileSync(file, "utf-8").replace(/\s+/g, "");
        fs.unlinkSync(file);
        this.emit("data", Buffer.from(hex, "hex"));
      }
      if (has("frames") && Date.now() - lastFrame >= FRAME_MS) {
        lastFrame = Date.now();
        let options = {};
        try { options = JSON.parse(fs.readFileSync(path.join(DIR, "frames"), "utf-8") || "{}"); } catch { /* defaults */ }
        this.emitFrame(options);
      }
    }, 40);
  }

  emitFrame(options) {
    this.emit("data", Buffer.from(`rx0: rssi=${options.rssi ?? -65} freqDev=1500 mcs=0 bw=1MHz\r\n`));
    const frame = Buffer.concat([Buffer.alloc(14), telemetry(global.__fakeFrameCount++, options)]);
    // like a UART, sometimes a frame arrives in two pieces
    this.emit("data", Buffer.concat([Buffer.from("+RXDATA:67\r\n"), frame.subarray(0, 30)]));
    setTimeout(() => this.emit("data", Buffer.concat([frame.subarray(30), Buffer.from("\r\n")])), 15);
  }

  shutdown() {
    clearInterval(this.watch);
    this.isOpen = false;
    if (global.__fakeOpen === this) global.__fakeOpen = null;
  }

  write(data) {
    const text = String(data);
    fs.appendFileSync(path.join(DIR, "received.log"), text);
    const m = /^AT\+(\w+)=(.*)\r\n$/.exec(text);
    if (!m || !this.isOpen) return true;
    const [, name, value] = m;
    if (name === "TX_MCS" && value === "5") return true;
    setTimeout(() => {
      if (!this.isOpen) return;
      if (name === "TXPOWER" && value === "19") this.emit("data", Buffer.from("ERROR\r\n"));
      else this.emit("data", Buffer.from(`${name}=${value}\r\nOK\r\n`));
    }, 30);
    return true;
  }

  close(callback) {
    const wasOpen = this.isOpen;
    this.shutdown();
    if (wasOpen) this.emit("close");
    if (callback) callback();
  }

  static async list() { return [{ path: "FAKE", manufacturer: "fake" }]; }
}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "serialport") return { SerialPort: FakeSerialPort };
  return originalLoad.call(this, request, ...rest);
};
