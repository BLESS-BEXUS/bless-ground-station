import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlessPacket } from "./protocol";
import { hasValidFix, RouteTracker, validRssi } from "./track";

function packet(lat: number, lng: number, extra: Partial<BlessPacket> = {}): BlessPacket {
  return {
    timestamp: 0, packetCount: 1,
    latitude: lat, longitude: lng, altitude: 1000, gpsFix: true, gpsSats: 10,
    rssi: -70, snr: 10, freqDevHz: 0, successRate: 100, noiseFloor: -100, txMcs: 0,
    systemState: 2, systemStateLabel: "FLIGHT", halowCurrMa: 0, chipTempC: 0, heaterPower: 0,
    pressurePa: 0, extTempC: 0, intTempC: 0, extHumidityRh: 0, radiationCps: 0,
    errorFlags: 0, halowStatus: "ACTIVE", receivedAt: new Date(0).toISOString(),
    ...extra,
  };
}

test("route is blue while HaLow GNSS arrives and turns yellow when only E-Link remains", () => {
  const tracker = new RouteTracker(null, 30_000);
  const links = [
    tracker.record(packet(67.90, 21.10), "elink", 1_000)?.link,   // nothing from HaLow yet
    tracker.record(packet(67.91, 21.10), "halow", 6_000)?.link,   // HaLow arrives
    tracker.record(packet(67.92, 21.10), "elink", 11_000)?.link,  // E-Link while HaLow is recent
    tracker.record(packet(67.93, 21.10), "halow", 16_000)?.link,
    tracker.record(packet(67.94, 21.10), "elink", 40_000)?.link,  // 24 s since HaLow: still recent
    tracker.record(packet(67.95, 21.10), "elink", 47_000)?.link,  // 31 s since HaLow: lost
    tracker.record(packet(67.96, 21.10), "halow", 60_000)?.link,  // HaLow comes back
  ];
  assert.deepEqual(links, ["elink", "halow", "halow", "halow", "halow", "elink", "halow"]);
});

test("points without a GNSS fix are not recorded", () => {
  const tracker = new RouteTracker(null);
  assert.equal(tracker.record(packet(67.9, 21.1, { gpsFix: false }), "elink", 1_000), null);
  assert.equal(tracker.record(packet(0, 0), "elink", 2_000), null);
  assert.equal(tracker.record(packet(Number.NaN, 21.1), "elink", 3_000), null);
  assert.equal(tracker.list().length, 0);
  assert.equal(hasValidFix(packet(91, 0)), false);
  assert.equal(hasValidFix(packet(67.9, 21.1)), true);
});

test("a repeated position on the same link is recorded once", () => {
  const tracker = new RouteTracker(null);
  tracker.record(packet(67.9, 21.1), "elink", 1_000);
  assert.equal(tracker.record(packet(67.9, 21.1), "elink", 6_000), null);
  assert.equal(tracker.record(packet(67.9, 21.1), "halow", 7_000)?.link, "halow");
  assert.equal(tracker.list().length, 2);
});

test("each point keeps the RSSI of its packet, and a new reading at the same spot is kept", () => {
  const tracker = new RouteTracker(null);
  assert.equal(tracker.record(packet(67.9, 21.1, { rssi: -60 }), "elink", 1_000)?.rssi, -60);
  assert.equal(tracker.record(packet(67.9, 21.1, { rssi: -60 }), "elink", 6_000), null);
  assert.equal(tracker.record(packet(67.9, 21.1, { rssi: -72 }), "elink", 11_000)?.rssi, -72);
  assert.equal(tracker.list().length, 2);
});

test("implausible RSSI readings are stored as null instead of a color", () => {
  assert.equal(validRssi(-59), -59);
  assert.equal(validRssi(0), null);          // payload glitch seen in the logs
  assert.equal(validRssi(-200), null);
  assert.equal(validRssi(Number.NaN), null);
  const tracker = new RouteTracker(null);
  assert.equal(tracker.record(packet(67.9, 21.1, { rssi: 0 }), "halow", 1_000)?.rssi, null);
});

test("route survives a restart and can be cleared", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bless-route-"));
  const file = path.join(directory, "logs", "route.ndjson");
  try {
    const first = new RouteTracker(file);
    first.record(packet(67.90, 21.10, { rssi: -61 }), "halow", 1_000);
    first.record(packet(67.91, 21.11, { rssi: -75 }), "elink", 100_000);
    fs.appendFileSync(file, "{corrupt\n");

    const restarted = new RouteTracker(file);
    restarted.load();
    assert.deepEqual(
      restarted.list().map((p) => [p.lat, p.link, p.rssi]),
      [[67.90, "halow", -61], [67.91, "elink", -75]],
    );

    restarted.clear();
    assert.equal(restarted.list().length, 0);
    const afterClear = new RouteTracker(file);
    afterClear.load();
    assert.equal(afterClear.list().length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
