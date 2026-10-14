import fs from "node:fs";
import path from "node:path";
import type { BlessPacket } from "./protocol";

/**
 * "halow": HaLow GNSS was being received when the point was recorded (E-Link may
 *          be arriving too). "elink": only E-Link was feeding the ground station.
 */
export type RouteLink = "halow" | "elink";

export interface RoutePoint {
  lat: number;
  lng: number;
  alt: number;
  /** Epoch ms at the ground station. */
  t: number;
  link: RouteLink;
  /** Payload packet counter, for reference. */
  pkt: number;
  /** RSSI (dBm) reported in the packet, or null when the reading is not plausible. */
  rssi: number | null;
}

type FixFields = Pick<BlessPacket, "latitude" | "longitude" | "gpsFix">;

/**
 * The payload occasionally reports 0 dBm (with a -34 dBm noise floor) for one
 * packet; a real HaLow reading is always well below 0 and above the receiver floor.
 */
export function validRssi(value: number): number | null {
  return Number.isFinite(value) && value < 0 && value > -130 ? value : null;
}

export function hasValidFix(p: FixFields): boolean {
  return p.gpsFix
    && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
    && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180
    && !(p.latitude === 0 && p.longitude === 0);
}

/**
 * Records the payload's GNSS route point by point. A point is "halow" while HaLow
 * GNSS has been received recently, and "elink" once only E-Link keeps arriving.
 * The route is appended to an NDJSON file so it survives a backend restart.
 */
export class RouteTracker {
  private points: RoutePoint[] = [];
  private lastHalowFixAt = 0;

  constructor(
    private readonly file: string | null,
    /** Longer than the slowest HaLow downlink period (~10 s). */
    private readonly halowWindowMs = 30_000,
    private readonly maxPoints = 20_000,
  ) {}

  load(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    const loaded: RoutePoint[] = [];
    for (const line of fs.readFileSync(this.file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as RoutePoint;
        if (Number.isFinite(p.lat) && Number.isFinite(p.lng)
            && (p.link === "halow" || p.link === "elink")) {
          loaded.push({
            lat: p.lat, lng: p.lng, alt: p.alt ?? 0, t: p.t ?? 0, link: p.link, pkt: p.pkt ?? 0,
            // routes saved before RSSI was recorded have no value
            rssi: typeof p.rssi === "number" ? validRssi(p.rssi) : null,
          });
        }
      } catch {
        // skip a corrupt line (e.g. a write cut by a crash)
      }
    }
    this.points = loaded.slice(-this.maxPoints);
  }

  record(
    packet: BlessPacket,
    via: RouteLink,
    now = Date.now(),
    /** The ground station's own RSSI, used when the payload's reading is not plausible. */
    rssiFallback: number | null = null,
  ): RoutePoint | null {
    if (!hasValidFix(packet)) return null;

    if (via === "halow") this.lastHalowFixAt = now;
    const halowRecent = this.lastHalowFixAt > 0 && now - this.lastHalowFixAt <= this.halowWindowMs;
    const link: RouteLink = halowRecent ? "halow" : "elink";

    const rssi = validRssi(packet.rssi) ?? (rssiFallback === null ? null : validRssi(rssiFallback));
    // Same spot, same link and same reading adds nothing; a new RSSI at the same
    // spot is still a sample worth keeping for the signal map.
    const last = this.points[this.points.length - 1];
    if (last && last.link === link && last.lat === packet.latitude
        && last.lng === packet.longitude && last.alt === packet.altitude
        && last.rssi === rssi) {
      return null;
    }

    const point: RoutePoint = {
      lat: packet.latitude,
      lng: packet.longitude,
      alt: packet.altitude,
      t: now,
      link,
      pkt: packet.packetCount,
      rssi,
    };
    this.points.push(point);
    if (this.points.length > this.maxPoints) {
      this.points.splice(0, this.points.length - this.maxPoints);
    }
    this.append(point);
    return point;
  }

  list(): RoutePoint[] {
    return this.points;
  }

  clear(): void {
    this.points = [];
    this.lastHalowFixAt = 0;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, "");
    } catch (err) {
      console.warn(`[route] Could not truncate ${this.file}: ${String(err)}`);
    }
  }

  private append(point: RoutePoint): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(point) + "\n");
    } catch (err) {
      console.warn(`[route] Could not persist route point: ${String(err)}`);
    }
  }
}
