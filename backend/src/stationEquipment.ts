import fs from "fs";
import path from "path";

/**
 * What the software cannot measure about the ground station's RF chain: antenna gain and
 * polarization, LNA and cable loss. The operator fills it in on the GS Config tab; it is
 * kept in a small file next to the backend so it survives restarts, and every mission
 * folder gets a copy in its configuration file.
 *
 * The payload's own equipment is not here: it is documented in the SED.
 */

export const POLARIZATIONS = ["vertical", "horizontal", "rhcp", "lhcp", "slant45", "unknown"] as const;
export type Polarization = (typeof POLARIZATIONS)[number];

export interface AntennaInfo {
  gainDbi: number | null;
  polarization: Polarization;
}

export interface LnaInfo {
  /** null = nobody has said. */
  present: boolean | null;
  gainDb: number | null;
}

export interface StationEquipment {
  groundAntenna: AntennaInfo;
  groundLna: LnaInfo;
  /** Loss between the ground module and its antenna (cable, connectors), in dB. */
  groundCableLossDb: number | null;
  notes: string;
  /** When the operator last saved it. null = nothing entered yet. */
  updatedAt: string | null;
}

/** Nothing is assumed: every figure is unknown until the operator enters it. */
export const DEFAULT_EQUIPMENT: StationEquipment = {
  groundAntenna: { gainDbi: null, polarization: "unknown" },
  groundLna: { present: null, gainDb: null },
  groundCableLossDb: null,
  notes: "",
  updatedAt: null,
};

export type EquipmentResult = { ok: true; value: StationEquipment } | { ok: false; error: string };

const MAX_NOTES = 600;

function numberOrNull(value: unknown, field: string, min: number, max: number): number | null | { error: string } {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return { error: `${field} must be a number between ${min} and ${max}, or empty` };
  }
  return value;
}

function isError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

/** Checks what the page sends. Missing fields fall back to "unknown", never to a guess. */
export function parseEquipment(input: unknown, now = new Date()): EquipmentResult {
  if (!input || typeof input !== "object") return { ok: false, error: "Body must be a JSON object" };
  const o = input as Record<string, unknown>;
  const antenna = (o.groundAntenna && typeof o.groundAntenna === "object" ? o.groundAntenna : {}) as Record<string, unknown>;
  const lna = (o.groundLna && typeof o.groundLna === "object" ? o.groundLna : {}) as Record<string, unknown>;

  const gain = numberOrNull(antenna.gainDbi, "groundAntenna.gainDbi", -20, 60);
  if (isError(gain)) return { ok: false, error: gain.error };
  const polarization = antenna.polarization ?? "unknown";
  if (typeof polarization !== "string" || !(POLARIZATIONS as readonly string[]).includes(polarization)) {
    return { ok: false, error: `groundAntenna.polarization must be one of ${POLARIZATIONS.join(", ")}` };
  }
  const lnaGain = numberOrNull(lna.gainDb, "groundLna.gainDb", 0, 60);
  if (isError(lnaGain)) return { ok: false, error: lnaGain.error };
  if (lna.present !== null && lna.present !== undefined && typeof lna.present !== "boolean") {
    return { ok: false, error: "groundLna.present must be true, false or empty" };
  }
  const cable = numberOrNull(o.groundCableLossDb, "groundCableLossDb", 0, 40);
  if (isError(cable)) return { ok: false, error: cable.error };

  return {
    ok: true,
    value: {
      groundAntenna: { gainDbi: gain, polarization: polarization as Polarization },
      groundLna: { present: (lna.present as boolean | null | undefined) ?? null, gainDb: lnaGain },
      groundCableLossDb: cable,
      notes: typeof o.notes === "string" ? o.notes.replace(/\s+/g, " ").trim().slice(0, MAX_NOTES) : "",
      updatedAt: now.toISOString(),
    },
  };
}

/** The current equipment, kept in a JSON file so a restart does not lose it. */
export class EquipmentStore {
  private current: StationEquipment = DEFAULT_EQUIPMENT;

  constructor(private readonly filePath: string) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { updatedAt?: unknown };
        const parsed = parseEquipment(raw);
        if (parsed.ok) {
          // the file's own timestamp says when the operator saved it, not when it was read;
          // fields an older version stored (models, payload values) are simply ignored
          this.current = { ...parsed.value, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null };
        } else {
          console.warn(`[equipment] ${filePath} ignored: ${parsed.error}`);
        }
      }
    } catch (error) {
      console.warn(`[equipment] ${filePath} could not be read: ${String(error)}`);
    }
  }

  get(): StationEquipment {
    return this.current;
  }

  set(value: StationEquipment): void {
    this.current = value;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, this.filePath);
  }
}
