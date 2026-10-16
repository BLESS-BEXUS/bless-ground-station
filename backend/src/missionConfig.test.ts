import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMissionConfig, writeMissionConfig, type MissionConfigInput } from "./missionConfig";
import { DEFAULT_EQUIPMENT, EquipmentStore, parseEquipment } from "./stationEquipment";

function input(over: Partial<MissionConfigInput> = {}): MissionConfigInput {
  return {
    session: "2026-10-15T09-00-00-000Z",
    folder: "mission_2026-10-15T09-00-00-000Z",
    startedAt: "2026-10-15T09:00:00.000Z",
    endedAt: null,
    position: { lat: 67.87964, lng: 21.062234, alt: 484, name: "Radar Hill", source: "operator" },
    positionSince: "2026-10-15T08:55:00.000Z",
    positionChanges: [],
    equipment: DEFAULT_EQUIPMENT,
    equipmentChanges: [],
    groundRadio: { port: "COM3", connected: true, applied: {}, lmac: null },
    payloadCommands: [],
    rows: { halow: 0, elink: 0, gsRf: 0, events: 0, route: 0 },
    files: [],
    ...over,
  };
}

test("without a TXPOWER applied from the software, the ground power is reported as not set", () => {
  const config = buildMissionConfig(input());
  const power = config.groundStation.radio.txPower;
  assert.equal(power.dBm, null);
  assert.equal(power.origin, "not-set-this-run");
  assert.equal(power.missionDefaultDbm, 9);
  assert.match(power.note ?? "", /did not set TXPOWER/);
});

test("a TXPOWER applied from the software is the ground power, with the time it was applied", () => {
  const config = buildMissionConfig(input({
    groundRadio: {
      port: "COM3", connected: true, lmac: null,
      applied: { TXPOWER: { value: "12", at: "2026-10-15T08:58:00.000Z" }, MODE: { value: "STA", at: "2026-10-15T08:59:00.000Z" } },
    },
  }));
  assert.deepEqual(
    { ...config.groundStation.radio.txPower, note: null },
    { dBm: 12, origin: "applied-from-software", appliedAt: "2026-10-15T08:58:00.000Z", missionDefaultDbm: 9, note: null },
  );
  assert.equal(config.groundStation.radio.appliedFromSoftware.MODE.value, "STA");
});

test("the payload power is only what a SET_TX_POWER command set, never a guess", () => {
  const before = buildMissionConfig(input());
  assert.equal(before.payload.txPower.dBm, null);
  assert.equal(before.payload.txPower.origin, "not-changed-this-run");
  assert.deepEqual(before.payload.commandsSent, []);

  const after = buildMissionConfig(input({
    payloadCommands: [
      { at: "2026-10-15T08:50:00.000Z", command: "SET_TX_POWER", params: [14] },
      { at: "2026-10-15T09:10:00.000Z", command: "SET_MCS_MODE", params: [2] },
      { at: "2026-10-15T09:20:00.000Z", command: "SET_TX_POWER", params: [10] },
    ],
  }));
  assert.equal(after.payload.txPower.dBm, 10);
  assert.equal(after.payload.txPower.origin, "command");
  assert.deepEqual(after.payload.commandsSent.map((c) => c.beforeMissionStart), [true, false, false]);
});

test("the equipment holds only the ground side, and unconfirmed is marked as such", () => {
  const unconfirmed = buildMissionConfig(input()).groundStation.equipment;
  assert.equal(unconfirmed.confirmedByOperator, false);
  assert.deepEqual(Object.keys(unconfirmed).sort(),
    ["confirmedByOperator", "groundAntenna", "groundCableLossDb", "groundLna", "notes", "updatedAt"]);

  const parsed = parseEquipment({ groundAntenna: { gainDbi: 10, polarization: "rhcp" } }, new Date("2026-10-15T08:00:00Z"));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const config = buildMissionConfig(input({ equipment: parsed.value }));
    assert.equal(config.groundStation.equipment.confirmedByOperator, true);
    assert.equal(config.groundStation.equipment.groundAntenna.polarization, "rhcp");
  }
});

test("the position note says when the page had not reported one, or only the default", () => {
  assert.match(buildMissionConfig(input({ position: null, positionSince: null })).groundStation.positionNote ?? "", /had not reported/);
  const asDefault = buildMissionConfig(input({
    position: { lat: 67.8856, lng: 21.0786, alt: 310, name: "Esrange Space Center", source: "default" },
  }));
  assert.match(asDefault.groundStation.positionNote ?? "", /no distances were computed/);
  assert.equal(buildMissionConfig(input()).groundStation.positionNote, null);
});

test("the row counts include the mission's own route journal", () => {
  const config = buildMissionConfig(input({ rows: { halow: 4, elink: 5, gsRf: 5, events: 3, route: 9 } }));
  assert.equal(config.mission.rows.route, 9);
});

test("the configuration file is written whole and named after the session", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bless-config-"));
  try {
    const file = writeMissionConfig(dir, "abc", buildMissionConfig(input({ session: "abc" })));
    assert.equal(path.basename(file), "mission_config_abc.json");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).mission.session, "abc");
    assert.deepEqual(fs.readdirSync(dir), ["mission_config_abc.json"], "no temporary file is left behind");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("equipment values are checked, and unknown stays unknown", () => {
  assert.equal(parseEquipment(null).ok, false);
  assert.equal(parseEquipment({ groundAntenna: { gainDbi: 400 } }).ok, false);
  assert.equal(parseEquipment({ groundAntenna: { polarization: "diagonal" } }).ok, false);
  assert.equal(parseEquipment({ groundLna: { present: "yes" } }).ok, false);
  assert.equal(parseEquipment({ groundCableLossDb: -3 }).ok, false);
  const empty = parseEquipment({});
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.value.groundAntenna.gainDbi, null);
    assert.equal(empty.value.groundAntenna.polarization, "unknown");
    assert.equal(empty.value.groundLna.present, null);
    assert.equal(empty.value.groundCableLossDb, null);
  }
});

test("fields that are no longer kept (models, payload values) are dropped, not stored", () => {
  const parsed = parseEquipment({
    groundAntenna: { model: "Yagi", gainDbi: 12, polarization: "vertical" },
    groundLna: { present: true, gainDb: 20, model: "LNA-866" },
    payloadAntenna: { gainDbi: 2 }, payloadLna: { present: true, gainDb: 5 }, payloadTxPowerDbm: 9,
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const keys = JSON.stringify(parsed.value);
    assert.equal(keys.includes("Yagi"), false);
    assert.equal(keys.includes("LNA-866"), false);
    assert.equal(keys.includes("payload"), false);
    assert.equal(parsed.value.groundAntenna.gainDbi, 12);
  }
});

test("the store keeps what was saved across a restart, and falls back to defaults on a bad file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bless-equip-"));
  const file = path.join(dir, "station_equipment.json");
  try {
    const first = new EquipmentStore(file);
    assert.equal(first.get().updatedAt, null);
    assert.equal(first.get().groundAntenna.gainDbi, null, "nothing is assumed");
    const parsed = parseEquipment({ groundAntenna: { gainDbi: 12, polarization: "vertical" }, groundCableLossDb: 2.5 },
      new Date("2026-10-15T08:00:00Z"));
    assert.equal(parsed.ok, true);
    if (parsed.ok) first.set(parsed.value);

    const second = new EquipmentStore(file);
    assert.equal(second.get().groundAntenna.gainDbi, 12);
    assert.equal(second.get().groundCableLossDb, 2.5);
    assert.equal(second.get().updatedAt, "2026-10-15T08:00:00.000Z", "keeps the time it was saved, not the time it was read");

    fs.writeFileSync(file, "{not json", "utf-8");
    assert.equal(new EquipmentStore(file).get().updatedAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
