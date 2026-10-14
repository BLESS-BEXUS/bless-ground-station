import assert from "node:assert/strict";
import test from "node:test";
import type { BlessPacket } from "./protocol";
import type { GsRfSnapshot } from "./gsLmac";
import { GsRadioLive, plausibleRssi } from "./gsRadio";

function blankPacket(): BlessPacket {
  return {
    timestamp: 0, packetCount: 1, latitude: 67.9, longitude: 21.1, altitude: 300, gpsFix: true, gpsSats: 10,
    rssi: 0, snr: 0, freqDevHz: 0, successRate: 100, noiseFloor: 0, txMcs: 0,
    systemState: 2, systemStateLabel: "FLIGHT", halowCurrMa: 0, chipTempC: 0, heaterPower: 0,
    pressurePa: 0, extTempC: 0, intTempC: 0, extHumidityRh: 0, radiationCps: 0,
    errorFlags: 0, halowStatus: "ACTIVE", receivedAt: new Date(0).toISOString(),
  };
}

function snapshot(over: Partial<GsRfSnapshot> = {}): GsRfSnapshot {
  return {
    t: 1_000, uptimeMs: 1, freqMHz: 866, bwMHz: 1, rssi: null, snr: null, noiseFloor: null, background: -60,
    rxFrames: 0, rxKbps: 0, rxErrPhy: 0, rxErrFcs: 0, rxGain: 5, txFrames: 3, txPerPct: 0, txKbps: 7,
    txMcs: 0, txPowerIndex: 0, chipTempC: 35, vcc: 3.3, stations: 0, ...over,
  };
}

test("0 dBm and out-of-range values are not radio readings", () => {
  assert.equal(plausibleRssi(0), false);
  assert.equal(plausibleRssi(-200), false);
  assert.equal(plausibleRssi(null), false);
  assert.equal(plausibleRssi(-67), true);
});

test("the rx0 and tx0 lines of the module give RSSI, frequency deviation, MCS, SNR and PER", () => {
  const radio = new GsRadioLive(60_000, () => 1_000);
  assert.equal(radio.fromRx0Line("rx0: rssi=-60 freqDev=-1500 mcs=2 bw=1MHz"), true);
  assert.equal(radio.fromTx0Line("tx0: snr=34 per= 3"), true);
  assert.equal(radio.fromRx0Line("something else"), false);
  assert.equal(radio.get("rssi"), -60);
  assert.equal(radio.get("freqDev"), -1500);          // sign is kept
  assert.equal(radio.get("mcs"), 2);
  assert.equal(radio.get("snr"), 34);
  assert.equal(radio.get("per"), 3);
  assert.equal(radio.noiseFloor(), -94);              // rssi - snr
});

test("a reading expires instead of being shown as current", () => {
  let clock = 1_000;
  const radio = new GsRadioLive(60_000, () => clock);
  radio.fromRx0Line("rx0: rssi=-60 freqDev=10 mcs=0 bw=1MHz");
  clock += 59_000;
  assert.equal(radio.get("rssi"), -60);
  clock += 2_000;
  assert.equal(radio.get("rssi"), null);
  assert.equal(radio.noiseFloor(), null);
});

test("an rx0 line with rssi=0 does not overwrite a real reading", () => {
  const radio = new GsRadioLive(60_000, () => 1_000);
  radio.fromRx0Line("rx0: rssi=-70 freqDev=0 mcs=0 bw=1MHz");
  radio.fromRx0Line("rx0: rssi=0 freqDev=0 mcs=0 bw=1MHz");
  assert.equal(radio.get("rssi"), -70);
});

test("a status snapshot supplies RSSI, SNR and the noise floor the module computed", () => {
  const radio = new GsRadioLive(60_000, () => 2_000);
  radio.fromSnapshot(snapshot({ rssi: -67, snr: 31, noiseFloor: -98, txPerPct: 2, txMcs: 1 }));
  assert.equal(radio.get("rssi"), -67);
  assert.equal(radio.get("snr"), 31);
  assert.equal(radio.noiseFloor(), -98);
  assert.equal(radio.get("per"), 2);
  assert.equal(radio.get("mcs"), 1);
});

test("an idle snapshot (nothing received) leaves the previous reading in place until it expires", () => {
  let clock = 1_000;
  const radio = new GsRadioLive(60_000, () => clock);
  radio.fromSnapshot(snapshot({ t: 1_000, rssi: -67, snr: 31, noiseFloor: -98 }));
  clock = 10_000;
  radio.fromSnapshot(snapshot({ t: 10_000 }));         // rssi null: not an overwrite
  assert.equal(radio.get("rssi"), -67);
  clock = 200_000;
  assert.equal(radio.get("rssi"), null);
});

test("attach puts the figures on a packet that carries zeros, leaving the payload's own values alone", () => {
  const radio = new GsRadioLive(60_000, () => 1_000);
  radio.fromRx0Line("rx0: rssi=-64 freqDev=900 mcs=0 bw=1MHz");
  radio.fromTx0Line("tx0: snr=30 per=0");
  const packet = radio.attach(blankPacket());
  assert.equal(packet.rssi, 0);                        // as the payload sent it
  assert.equal(packet.gsRssi, -64);
  assert.equal(packet.gsSnr, 30);
  assert.equal(packet.gsNoiseFloor, -94);
  assert.equal(packet.gsFreqDev, 900);
  assert.equal(packet.gsMcs, 0);
  assert.equal(packet.gsPer, 0);
});

test("attach leaves every gs field undefined when nothing fresh is known", () => {
  const radio = new GsRadioLive(60_000, () => 1_000);
  const packet = radio.attach(blankPacket());
  assert.equal(packet.gsRssi, undefined);
  assert.equal(packet.gsSnr, undefined);
  assert.equal(packet.gsNoiseFloor, undefined);
});
