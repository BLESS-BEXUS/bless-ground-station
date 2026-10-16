import assert from "node:assert/strict";
import test from "node:test";
import type { BlessPacket } from "./protocol";
import {
  GsPositionState,
  describePosition,
  groundDistanceM,
  parseGsPosition,
  slantDistanceM,
  type GsPosition,
} from "./gsPosition";

function blankPacket(over: Partial<BlessPacket> = {}): BlessPacket {
  return {
    timestamp: 0, packetCount: 1, latitude: 67.8908, longitude: 21.0803, altitude: 343, gpsFix: true, gpsSats: 12,
    rssi: 0, snr: 0, freqDevHz: 0, successRate: 100, noiseFloor: 0, txMcs: 0,
    systemState: 2, systemStateLabel: "FLIGHT", halowCurrMa: 0, chipTempC: 0, heaterPower: 0,
    pressurePa: 0, extTempC: 0, intTempC: 0, extHumidityRh: 0, radiationCps: 0,
    errorFlags: 0, halowStatus: "ACTIVE", receivedAt: new Date(0).toISOString(), ...over,
  };
}

const radarHill: GsPosition = { lat: 67.87964, lng: 21.062234, alt: 484, name: "Radar Hill", source: "operator" };

test("a position needs real coordinates and a known source", () => {
  assert.equal(parseGsPosition(null).ok, false);
  assert.equal(parseGsPosition({ ...radarHill, lat: 91 }).ok, false);
  assert.equal(parseGsPosition({ ...radarHill, lng: "21" }).ok, false);
  assert.equal(parseGsPosition({ ...radarHill, alt: Number.NaN }).ok, false);
  assert.equal(parseGsPosition({ ...radarHill, source: "guess" }).ok, false);
  const ok = parseGsPosition({ ...radarHill, name: "  Radar \n Hill  " });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.name, "Radar Hill");
});

test("ground distance matches the Map tab formula, and the slant range adds the altitude difference", () => {
  // 0.01 degrees of latitude is 111.19 km on the 6371 km sphere the Map tab uses
  assert.ok(Math.abs(groundDistanceM(67, 21, 67.01, 21) - 1111.95) < 0.5);
  assert.equal(groundDistanceM(67.9, 21.1, 67.9, 21.1), 0);
  assert.equal(slantDistanceM(300, 0, 400), 500);
  assert.equal(slantDistanceM(300, 400, 0), 500);
});

test("a packet gets both distances once the operator's position is known", () => {
  const state = new GsPositionState();
  const packet = blankPacket();
  state.attach(packet);
  assert.equal(packet.gsDistHorizontalM, undefined, "no position yet: no distance");

  state.set(radarHill);
  state.attach(packet);
  const horizontal = groundDistanceM(radarHill.lat, radarHill.lng, packet.latitude, packet.longitude);
  assert.ok(Math.abs((packet.gsDistHorizontalM ?? 0) - horizontal) < 0.06);
  assert.ok(Math.abs((packet.gsDistSlantM ?? 0) - Math.hypot(horizontal, 343 - 484)) < 0.06);
  assert.ok((packet.gsDistSlantM ?? 0) > (packet.gsDistHorizontalM ?? 0));
  // about 1.45 km: the Radar Hill to MPF link of the campaign
  assert.ok((packet.gsDistHorizontalM ?? 0) > 1400 && (packet.gsDistHorizontalM ?? 0) < 1500);
});

test("no distance from the campaign default, nor without a GNSS fix", () => {
  const state = new GsPositionState();
  state.set({ ...radarHill, source: "default" });
  const fromDefault = blankPacket();
  state.attach(fromDefault);
  assert.equal(fromDefault.gsDistHorizontalM, undefined);
  assert.equal(fromDefault.gsDistSlantM, undefined);

  state.set(radarHill);
  const noFix = blankPacket({ gpsFix: false });
  state.attach(noFix);
  assert.equal(noFix.gsDistHorizontalM, undefined);
  const nullIsland = blankPacket({ latitude: 0, longitude: 0 });
  state.attach(nullIsland);
  assert.equal(nullIsland.gsDistHorizontalM, undefined);
});

test("only a different position counts as a change", () => {
  const state = new GsPositionState();
  assert.equal(state.set(radarHill, new Date("2026-10-15T09:00:00Z")), true);
  assert.equal(state.getSince(), "2026-10-15T09:00:00.000Z");
  assert.equal(state.set({ ...radarHill }, new Date("2026-10-15T09:05:00Z")), false);
  assert.equal(state.getSince(), "2026-10-15T09:00:00.000Z", "an identical report keeps the original time");
  assert.equal(state.set({ ...radarHill, alt: 490 }), true);
  assert.equal(state.set({ ...radarHill, alt: 490, source: "default" }), true);
});

test("the event text has no commas, so it fits one CSV cell", () => {
  const text = describePosition({ ...radarHill, name: "Radar, Hill; north" });
  assert.equal(text.includes(","), false);
  assert.match(text, /^lat=67\.8796400;lng=21\.0622340;alt=484;name=Radar {2}Hill {2}north$/);
});
