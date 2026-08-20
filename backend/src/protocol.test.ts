import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPingCommand,
  ELINK_COMMAND_SIZE,
  ELINK_PONG_ID,
  PACKET_SIZE,
  parsePacket,
  parsePong,
  SYNC_MARKER,
} from "./protocol";
import { MissionLogger } from "./logger";

function crc16(buf: Buffer, length: number): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc;
}

function makePacket(pressurePa: number): Buffer {
  const buf = Buffer.alloc(PACKET_SIZE);
  buf.writeUInt16LE(SYNC_MARKER, 0);
  buf.writeUInt32LE(12_345, 2);
  buf.writeUInt32LE(27, 6);
  buf.writeInt32LE(678_856_000, 10);
  buf.writeInt32LE(210_786_000, 14);
  buf.writeUInt16LE(40_000, 18);
  buf.writeUInt8((1 << 6) | 12, 20);
  buf.writeInt16LE(-63, 21);
  buf.writeInt8(18, 23);
  buf.writeInt16LE(120, 24);
  buf.writeUInt8(98, 26);
  buf.writeInt16LE(-81, 27);
  buf.writeUInt8(3, 29);
  buf.writeUInt16LE(2, 30);
  buf.writeUInt16LE(125, 32);
  buf.writeInt16LE(47, 34);
  buf.writeUInt16LE(5_250, 36);
  buf.writeUInt32LE(pressurePa, 38);
  buf.writeInt16LE(-1_250, 42);
  buf.writeInt16LE(2_175, 44);
  buf.writeUInt16LE(4_550, 46);
  buf.writeUInt16LE(8, 48);
  buf.writeUInt8(0, 50);
  buf.writeUInt16LE(crc16(buf, 51), 51);
  return buf;
}

test("decodes the packed flight telemetry units and bit fields", () => {
  const packet = parsePacket(makePacket(98_765));

  assert.ok(packet);
  assert.equal(packet.chipTempC, 47);
  assert.equal(packet.pressurePa, 98_765);
  assert.equal(packet.heaterPower, 52.5);
  assert.equal(packet.altitude, 40_000);
  assert.equal(packet.gpsFix, true);
  assert.equal(packet.gpsSats, 12);
  assert.equal(packet.systemState, 2);
  assert.equal(packet.systemStateLabel, "FLIGHT");
});

test("uses the pressure value from every newly received packet", () => {
  const first = parsePacket(makePacket(101_325));
  const second = parsePacket(makePacket(75_000));

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.pressurePa, 101_325);
  assert.equal(second.pressurePa, 75_000);
  assert.notEqual(first.pressurePa, second.pressurePa);
});

test("rejects telemetry with a corrupted CRC", () => {
  const corrupted = makePacket(101_325);
  corrupted[42] ^= 0x01;

  assert.equal(parsePacket(corrupted), null);
});

test("builds the firmware-compatible binary ping command", () => {
  const ping = buildPingCommand(0x1234);

  assert.equal(ping.length, ELINK_COMMAND_SIZE);
  assert.deepEqual(
    [...ping],
    [0x75, 0xe1, 0x45, 0xc2, 0x04, 0x02, 0x34, 0x12, 0xa9, 0x02],
  );
});

test("parses a pong and rejects a corrupted checksum", () => {
  const pong = buildPingCommand(0xbeef);
  pong.writeUInt8(ELINK_PONG_ID, 4);
  const checksum = [...pong.subarray(0, 8)].reduce((sum, byte) => (sum + byte) & 0xffff, 0);
  pong.writeUInt16LE(checksum, 8);

  assert.deepEqual(parsePong(pong), { token: 0xbeef });

  pong[6] ^= 0x01;
  assert.equal(parsePong(pong), null);
});

test("writes mission rows immediately to a session-specific file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bless-logger-"));
  try {
    const packet = parsePacket(makePacket(101_325));
    assert.ok(packet);

    const logger = new MissionLogger(directory, "elink_live.csv", "header\n");
    logger.open();
    logger.start("test-session");
    logger.write(packet);

    const filePath = logger.getFilePath();
    assert.equal(path.basename(filePath), "elink_live_test-session.csv");
    const content = fs.readFileSync(filePath, "utf-8");
    assert.ok(content.startsWith("header\n"));
    assert.equal(content.trim().split("\n").length, 2);
    logger.stop();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
