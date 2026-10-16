import fs from "fs";
import path from "path";
import type { GsPosition } from "./gsPosition";
import type { StationEquipment } from "./stationEquipment";

/**
 * The configuration a mission was run with, written next to its CSV files as
 * `mission_config_<session>.json`: where the ground station was, how its radio was set
 * (what the software applied and what it could only read), the antennas and LNA the
 * operator declared, and the commands sent to the payload. It is rewritten whenever one
 * of those changes, so the file always describes the whole run.
 */

/**
 * What the ground module is set to when nobody changes it from the software. It mirrors
 * the GS Config tab's mission defaults (frontend/src/lib/groundRadio.ts).
 */
export const GROUND_RADIO_MISSION_DEFAULTS = {
  TXPOWER_DBM: 9,
  TX_MCS: 0,
  BSS_BW_MHZ: 1,
  FREQ_RANGE: "8660,8670",
} as const;

export interface AppliedSetting {
  value: string;
  at: string;
}

export interface PayloadCommandRecord {
  at: string;
  command: string;
  params: number[];
}

export interface PositionChange {
  at: string;
  position: GsPosition;
}

export interface EquipmentChange {
  at: string;
  equipment: StationEquipment;
}

export interface MissionConfigInput {
  session: string;
  folder: string;
  startedAt: string;
  endedAt: string | null;
  position: GsPosition | null;
  positionSince: string | null;
  positionChanges: PositionChange[];
  equipment: StationEquipment;
  equipmentChanges: EquipmentChange[];
  groundRadio: {
    port: string;
    connected: boolean;
    applied: Record<string, AppliedSetting | undefined>;
    /** What the module reports about itself in its LMAC dump, when it has printed one. */
    lmac: { freqMHz: number | null; bwMHz: number | null; txMcs: number | null; txPowerIndex: number | null } | null;
  };
  payloadCommands: PayloadCommandRecord[];
  rows: { halow: number; elink: number; gsRf: number; events: number; route: number };
  files: string[];
}

export interface MissionConfig {
  schema: 1;
  mission: { session: string; folder: string; startedAt: string; endedAt: string | null; files: string[]; rows: MissionConfigInput["rows"] };
  groundStation: {
    position: (GsPosition & { reportedAt: string | null }) | null;
    positionNote: string | null;
    positionChanges: PositionChange[];
    radio: {
      module: { port: string; connected: boolean };
      txPower: { dBm: number | null; origin: "applied-from-software" | "not-set-this-run"; appliedAt: string | null; missionDefaultDbm: number; note: string | null };
      appliedFromSoftware: Record<string, AppliedSetting>;
      reportedByModule: MissionConfigInput["groundRadio"]["lmac"];
    };
    equipment: StationEquipment & { confirmedByOperator: boolean };
    equipmentChanges: EquipmentChange[];
  };
  payload: {
    /** Only what the software itself sent: the payload's own configuration is in the SED. */
    txPower: { dBm: number | null; origin: "command" | "not-changed-this-run"; note: string | null };
    commandsSent: (PayloadCommandRecord & { beforeMissionStart: boolean })[];
  };
}

function lastTxPowerCommand(commands: PayloadCommandRecord[]): PayloadCommandRecord | null {
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i].command === "SET_TX_POWER" && commands[i].params.length === 1) return commands[i];
  }
  return null;
}

export function buildMissionConfig(input: MissionConfigInput): MissionConfig {
  const applied: Record<string, AppliedSetting> = {};
  for (const [name, entry] of Object.entries(input.groundRadio.applied)) {
    if (entry) applied[name] = entry;
  }

  const gsPower = applied.TXPOWER;
  const gsPowerNumber = gsPower ? Number(gsPower.value) : null;
  const txPower = gsPower && Number.isFinite(gsPowerNumber)
    ? {
        dBm: gsPowerNumber,
        origin: "applied-from-software" as const,
        appliedAt: gsPower.at,
        missionDefaultDbm: GROUND_RADIO_MISSION_DEFAULTS.TXPOWER_DBM,
        note: null,
      }
    : {
        dBm: null,
        origin: "not-set-this-run" as const,
        appliedAt: null,
        missionDefaultDbm: GROUND_RADIO_MISSION_DEFAULTS.TXPOWER_DBM,
        note: "The software did not set TXPOWER in this run; the module used the value it already had "
          + `(the mission default is ${GROUND_RADIO_MISSION_DEFAULTS.TXPOWER_DBM} dBm).`,
      };

  const lastCommand = lastTxPowerCommand(input.payloadCommands);
  const payloadPower = lastCommand
    ? { dBm: lastCommand.params[0], origin: "command" as const, note: `Set by SET_TX_POWER at ${lastCommand.at}.` }
    : {
        dBm: null,
        origin: "not-changed-this-run" as const,
        note: "No SET_TX_POWER was sent from the software in this run: the payload keeps the power its firmware sets.",
      };

  return {
    schema: 1,
    mission: {
      session: input.session,
      folder: input.folder,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      files: input.files,
      rows: input.rows,
    },
    groundStation: {
      position: input.position ? { ...input.position, reportedAt: input.positionSince } : null,
      positionNote: input.position === null
        ? "The page had not reported the ground station's position when the mission started."
        : input.position.source === "default"
          ? "Campaign default: the operator had not entered coordinates, so no distances were computed."
          : null,
      positionChanges: input.positionChanges,
      radio: {
        module: input.groundRadio.port ? { port: input.groundRadio.port, connected: input.groundRadio.connected } : { port: "", connected: false },
        txPower,
        appliedFromSoftware: applied,
        reportedByModule: input.groundRadio.lmac,
      },
      equipment: { ...input.equipment, confirmedByOperator: input.equipment.updatedAt !== null },
      equipmentChanges: input.equipmentChanges,
    },
    payload: {
      txPower: payloadPower,
      commandsSent: input.payloadCommands.map((c) => ({ ...c, beforeMissionStart: c.at < input.startedAt })),
    },
  };
}

/** Writes the file in one step, so a reader never sees half of it. */
export function writeMissionConfig(dir: string, session: string, config: MissionConfig): string {
  const file = path.join(dir, `mission_config_${session}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
  return file;
}
