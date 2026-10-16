import type { BlessPacket } from "./protocol";

/**
 * Where the ground station is. The page keeps the coordinates (the operator types them
 * in on the Antenna tab) and reports them here, so the logs can say how far the payload
 * was from the ground station when each packet arrived.
 */
export interface GsPosition {
  lat: number;
  lng: number;
  /** Metres above sea level, the same reference as the payload's GNSS altitude. */
  alt: number;
  name: string;
  /**
   * "operator": coordinates the operator entered.
   * "default": the campaign default the page falls back to until then. Distances are not
   * computed from it, because a number measured from the wrong place is worse than none.
   */
  source: "operator" | "default";
}

export type GsPositionResult = { ok: true; value: GsPosition } | { ok: false; error: string };

const EARTH_RADIUS_M = 6_371_000;
const MAX_NAME_LENGTH = 80;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Checks a request body; the reply says which field is wrong. */
export function parseGsPosition(input: unknown): GsPositionResult {
  if (!input || typeof input !== "object") return { ok: false, error: "Body must be a JSON object" };
  const o = input as Record<string, unknown>;
  if (!finite(o.lat) || o.lat < -90 || o.lat > 90) return { ok: false, error: "lat must be a number between -90 and 90" };
  if (!finite(o.lng) || o.lng < -180 || o.lng > 180) return { ok: false, error: "lng must be a number between -180 and 180" };
  if (!finite(o.alt) || o.alt < -500 || o.alt > 10_000) return { ok: false, error: "alt must be a number of metres between -500 and 10000" };
  if (o.source !== "operator" && o.source !== "default") return { ok: false, error: 'source must be "operator" or "default"' };
  const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) : "";
  return { ok: true, value: { lat: o.lat, lng: o.lng, alt: o.alt, name, source: o.source } };
}

/** Great-circle distance over the ground, in metres (the same formula as the Map tab). */
export function groundDistanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Straight line from the ground station to the payload: ground distance and altitude difference. */
export function slantDistanceM(horizontalM: number, gsAlt: number, payloadAlt: number): number {
  return Math.hypot(horizontalM, payloadAlt - gsAlt);
}

const tenth = (v: number) => Math.round(v * 10) / 10;

function samePosition(a: GsPosition, b: GsPosition): boolean {
  return Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lng - b.lng) < 1e-7
    && Math.abs(a.alt - b.alt) < 0.05 && a.name === b.name && a.source === b.source;
}

/** Cell text for a position, as it goes in the `source` column of mission_events. */
export function describePosition(p: GsPosition): string {
  const name = p.name.replace(/[,;\r\n]/g, " ").trim();
  return `lat=${p.lat.toFixed(7)};lng=${p.lng.toFixed(7)};alt=${p.alt}${name ? `;name=${name}` : ""}`;
}

export class GsPositionState {
  private current: GsPosition | null = null;
  private since: string | null = null;

  get(): GsPosition | null { return this.current; }

  /** When the current position was reported (ISO UTC). */
  getSince(): string | null { return this.since; }

  /** Returns true when the position is new or different from the one held. */
  set(next: GsPosition, now = new Date()): boolean {
    if (this.current && samePosition(this.current, next)) return false;
    this.current = next;
    this.since = now.toISOString();
    return true;
  }

  /**
   * Adds the distances GS -> payload to a packet, when both ends are known: the operator
   * set the ground station's coordinates and the payload has a GNSS fix.
   */
  attach(packet: BlessPacket): void {
    const gs = this.current;
    if (!gs || gs.source !== "operator") return;
    if (!packet.gpsFix) return;
    if (packet.latitude === 0 && packet.longitude === 0) return;
    const horizontal = groundDistanceM(gs.lat, gs.lng, packet.latitude, packet.longitude);
    packet.gsDistHorizontalM = tenth(horizontal);
    packet.gsDistSlantM = tenth(slantDistanceM(horizontal, gs.alt, packet.altitude));
  }
}
