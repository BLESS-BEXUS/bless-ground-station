/**
 * BLESS downlink packet parser — BX38_BLESS_SED
 *
 * Binary layout (53 bytes, little-endian, __attribute__((packed))):
 *
 * Header
 *   SYNC          uint16   2   Fixed: 0xB1E5 (or 0xAA55 dev)
 *   TIMESTAMP     uint32   4   ms since boot
 *   COUNT         uint32   4   sequential counter
 * GNSS
 *   GPS_LAT       int32    4   decimal degrees × 1e7
 *   GPS_LON       int32    4   decimal degrees × 1e7
 *   GPS_ALT       uint16   2   meters ASL
 *   GPS_FIX_SATS  int8     1   bits7-6=fix quality, bits5-0=num_sats
 * RF Performance
 *   RF_RSSI       int16    2   dBm
 *   RF_SNR        int8     1   dB
 *   RF_FREQ_DEV   int16    2   Hz
 *   RF_SUCCESS_RATE uint8  1   % PDR
 *   RF_NOISE_FLOOR int16   2   dBm
 *   RF_TX_MCS     uint8    1   MCS index
 *   RF_VOLT       uint16   2   RF Log Detector mV
 * Hardware
 *   HALOW_CURR    uint16   2   mA (INA219)
 *   TEMP_CHIP     int16    2   whole °C (T-HaLow module statistic)
 *   HEATER_POWER  uint16   2   centi-% heater duty
 * Environment
 *   ENV_PRESS     uint32   4   Pa
 *   EXT_TEMP      int16    2   centi-°C
 *   INT_TEMP      int16    2   centi-°C
 *   EXT_HUM       uint16   2   centi-RH%
 *   RAD_CPS       uint16   2   counts/sec
 * Footer
 *   ERROR_FLAGS   uint8    1   sensor error bitmask
 *   CHECKSUM      uint16   2   CRC-16 Modbus
 *
 * Total: 53 bytes
 */

export const SYNC_MARKER = 0xb1e5;
export const SYNC_MARKER_ALT = 0xaa55;
export const PACKET_SIZE = 53;

export interface BlessPacket {
  // Header
  timestamp: number;
  packetCount: number;
  // GNSS
  latitude: number;
  longitude: number;
  altitude: number;
  gpsFix: boolean;
  gpsSats: number;
  // RF
  rssi: number;
  snr: number;
  freqDevHz: number;
  successRate: number;
  noiseFloor: number;
  txMcs: number;
  // Hardware
  rfVoltMv: number;
  halowCurrMa: number;
  chipTempC: number;
  heaterPower: number;
  // Environmental
  pressurePa: number;
  extTempC: number;
  intTempC: number;
  extHumidityRh: number;
  radiationCps: number;
  // Status
  errorFlags: number;
  // Derived
  halowStatus: "ACTIVE" | "DEGRADED" | "INTERRUPTED";
  receivedAt: string;
  // GS-side RF stats (from T-HaLow rx0/tx0 lines)
  gsRssi?: number;
  gsSnr?: number;
  gsFreqDev?: number;
  gsMcs?: number;
}

function crc16(buf: Buffer, length: number): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xa001;
      else crc >>= 1;
    }
  }
  return crc;
}

export function parsePacket(buf: Buffer): BlessPacket | null {
  if (buf.length < PACKET_SIZE) return null;

  const sync = buf.readUInt16LE(0);
  if (sync !== SYNC_MARKER && sync !== SYNC_MARKER_ALT) return null;

  const checksum = buf.readUInt16LE(51);
  const computed = crc16(buf, 51);
  if (checksum !== computed) {
    // Allow packets through with CRC warning during development
    console.warn(`[parser] CRC mismatch: got 0x${checksum.toString(16)}, expected 0x${computed.toString(16)} (accepting anyway)`);
  }

  const fixSats = buf.readUInt8(20);
  const fixQuality = fixSats >> 6;

  const rssi = buf.readInt16LE(21);
  const halowStatus =
    rssi > -70 ? "ACTIVE" : rssi > -85 ? "DEGRADED" : "INTERRUPTED";

  return {
    timestamp: buf.readUInt32LE(2),
    packetCount: buf.readUInt32LE(6),
    latitude: buf.readInt32LE(10) / 1e7,
    longitude: buf.readInt32LE(14) / 1e7,
    altitude: buf.readUInt16LE(18),
    gpsFix: fixQuality !== 0,
    gpsSats: fixSats & 0x3f,
    rssi,
    snr: buf.readInt8(23),
    freqDevHz: buf.readInt16LE(24),
    successRate: buf.readUInt8(26),
    noiseFloor: buf.readInt16LE(27),
    txMcs: buf.readUInt8(29),
    rfVoltMv: buf.readUInt16LE(30),
    halowCurrMa: buf.readUInt16LE(32),
    chipTempC: buf.readInt16LE(34),
    heaterPower: buf.readUInt16LE(36) / 100,
    pressurePa: buf.readUInt32LE(38),
    extTempC: buf.readInt16LE(42) / 100,
    intTempC: buf.readInt16LE(44) / 100,
    extHumidityRh: buf.readUInt16LE(46) / 100,
    radiationCps: buf.readUInt16LE(48),
    errorFlags: buf.readUInt8(50),
    halowStatus,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * E-Link uplink command builder — Table 428 of BX38_BLESS_SED_v2
 *
 * Frame: SYNC_1(2) + SYNC_2(2) + CMD_ID(1) + PAYLOAD_SIZE(1) + PAYLOAD(n) + CHECKSUM(2)
 * SYNC_1 = 0xE175, SYNC_2 = 0xC245
 */
export const CMD = {
  SYS_RESET: 0x01,
  SYS_ON: 0x02,
  SYS_OFF: 0x03,
  SYS_START: 0x04,
  SYS_STOP: 0x05,
  PING: 0x06,
  HEAT_MANUAL: 0x10,
  HEAT_AUTO: 0x11,
  HALOW_CONNECT: 0x20,
  SET_TX_POWER: 0x21,
  SET_MCS_MODE: 0x22,
  RF_SILENCE: 0x23,
  SAVE_DATA: 0x30,
  SEND_HALOW: 0x31,
  SEND_ELINK: 0x32,
} as const;

export type CmdId = (typeof CMD)[keyof typeof CMD];

const ELINK_CMD_SIZE = 10; // sync1(2) + sync2(2) + cmd_id(1) + payload_size(1) + payload[2] + checksum(2)

export function buildCommand(cmdId: CmdId, payload: Buffer = Buffer.alloc(0)): Buffer {
  const frame = Buffer.alloc(ELINK_CMD_SIZE);

  frame.writeUInt16LE(0xe175, 0);
  frame.writeUInt16LE(0xc245, 2);
  frame.writeUInt8(cmdId, 4);
  frame.writeUInt8(Math.min(payload.length, 2), 5);
  payload.copy(frame, 6, 0, Math.min(payload.length, 2));

  const checksum = crc16(frame, 8);
  frame.writeUInt16LE(checksum, 8);

  return frame;
}
