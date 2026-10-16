import fs from "node:fs";
import path from "node:path";
import type { RoutePoint } from "./track";

/**
 * The payload's GNSS route of one mission, as a GeoJSON FeatureCollection that opens in
 * QGIS. It is written into the mission's folder, next to its CSV files. Styling travels
 * with the file as simplestyle properties (stroke, stroke-width, marker-color), the same
 * colors the live map uses.
 */

const LINK_COLORS = { halow: "#1E88FF", elink: "#FFC400" } as const;
const NO_RSSI_COLOR = "#9AA5B1";
const RSSI_MIN_DBM = -107;
const RSSI_MAX_DBM = -30;
const RSSI_STOPS: { at: number; rgb: [number, number, number] }[] = [
  { at: 0.0, rgb: [142, 15, 27] },
  { at: 0.2, rgb: [229, 57, 53] },
  { at: 0.4, rgb: [251, 140, 0] },
  { at: 0.6, rgb: [253, 216, 53] },
  { at: 0.8, rgb: [124, 179, 66] },
  { at: 1.0, rgb: [27, 127, 59] },
];

/** Same scale as the live map (frontend/src/lib/route.ts), as #rrggbb. */
export function rssiColorHex(rssi: number | null): string {
  if (rssi === null) return NO_RSSI_COLOR;
  const f = Math.min(1, Math.max(0, (rssi - RSSI_MIN_DBM) / (RSSI_MAX_DBM - RSSI_MIN_DBM)));
  let i = 0;
  while (i < RSSI_STOPS.length - 2 && f > RSSI_STOPS[i + 1].at) i++;
  const a = RSSI_STOPS[i];
  const b = RSSI_STOPS[i + 1];
  const k = (f - a.at) / (b.at - a.at);
  const [r, g, bl] = a.rgb.map((c, n) => Math.round(c + (b.rgb[n] - c) * k));
  return "#" + [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export interface RouteMeta {
  /** The mission's session id (the one in its folder and file names). */
  session: string;
  /** Why it was written: "recording" (periodic), "rec-stop" or "shutdown". */
  reason: string;
}

type Position = [number, number, number];
const position = (p: RoutePoint): Position => [p.lng, p.lat, p.alt];

export function routeToGeoJson(points: RoutePoint[], meta: RouteMeta, writtenAt = new Date()) {
  const features: object[] = [];

  // 1. The route in the color of the link that fed each stretch (HaLow / E-Link only)
  let run: { link: RoutePoint["link"]; coordinates: Position[] } | null = null;
  const flush = () => {
    if (run && run.coordinates.length > 1) {
      features.push({
        type: "Feature",
        properties: {
          kind: "route", name: run.link === "halow" ? "HaLow GNSS" : "E-Link only", link: run.link,
          stroke: LINK_COLORS[run.link], "stroke-width": 4, "stroke-opacity": 1,
        },
        geometry: { type: "LineString", coordinates: run.coordinates },
      });
    }
  };
  points.forEach((p, i) => {
    if (!run || run.link !== p.link) {
      flush();
      run = { link: p.link, coordinates: i > 0 ? [position(points[i - 1])] : [] };
    }
    run.coordinates.push(position(p));
  });
  flush();

  // 2. One short line per leg, colored by the signal strength there
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const rssi = a.rssi !== null && b.rssi !== null ? (a.rssi + b.rssi) / 2 : null;
    features.push({
      type: "Feature",
      properties: {
        kind: "rssi-leg", name: rssi === null ? "No RSSI" : `${rssi.toFixed(0)} dBm`, rssi,
        stroke: rssiColorHex(rssi), "stroke-width": 6, "stroke-opacity": 1,
      },
      geometry: { type: "LineString", coordinates: [position(a), position(b)] },
    });
  }

  // 3. Every recorded point, with what was known there
  points.forEach((p, i) => {
    features.push({
      type: "Feature",
      properties: {
        kind: i === 0 ? "start" : i === points.length - 1 ? "end" : "point",
        time: new Date(p.t).toISOString(), t: p.t, alt: p.alt, rssi: p.rssi, link: p.link, pkt: p.pkt,
        "marker-color": rssiColorHex(p.rssi), "marker-size": "small",
      },
      geometry: { type: "Point", coordinates: position(p) },
    });
  });

  return {
    type: "FeatureCollection",
    bless: {
      session: meta.session,
      reason: meta.reason,
      points: points.length,
      startedAt: points.length ? new Date(points[0].t).toISOString() : null,
      endedAt: points.length ? new Date(points[points.length - 1].t).toISOString() : null,
      writtenAt: writtenAt.toISOString(),
    },
    features,
  };
}

/**
 * Writes `route_<session>.geojson` into the mission folder, replacing the previous
 * version of the same mission (it is rewritten while recording). Returns the file name,
 * or null when there is nothing to save.
 */
export function writeMissionRoute(dir: string, points: RoutePoint[], meta: RouteMeta): string | null {
  if (points.length === 0) return null;
  fs.mkdirSync(dir, { recursive: true });
  const name = `route_${meta.session}.geojson`;
  const file = path.join(dir, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(routeToGeoJson(points, meta)), "utf-8");
  fs.renameSync(tmp, file);
  return name;
}
