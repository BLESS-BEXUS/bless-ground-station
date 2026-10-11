/**
 * "halow": HaLow GNSS was being received when the point was recorded.
 * "elink": only E-Link was feeding the ground station.
 */
export type RouteLink = "halow" | "elink";

export interface RoutePoint {
  lat: number;
  lng: number;
  alt: number;
  /** Epoch ms at the ground station. */
  t: number;
  link: RouteLink;
  pkt: number;
  /** RSSI (dBm) of the packet; null when the reading was not plausible or missing. */
  rssi: number | null;
}

// ─── RSSI color scale ─────────────────────────────────────────────────────────
// Floor: MM6108 receive sensitivity, MCS10 / 1 MHz, 10 % PER (-107 dBm, Morse Micro
// datasheet): below it the link is lost. Ceiling: -30 dBm, roughly what the ground
// station sees from the payload a few tens of metres away. The receiver's absolute
// maximum rating is +6 dBm, but nothing in this experiment gets near it.
export const RSSI_MIN_DBM = -107;
export const RSSI_MAX_DBM = -30;

const RSSI_STOPS: { at: number; rgb: [number, number, number] }[] = [
  { at: 0.0, rgb: [142, 15, 27] },    // -107 dBm  dark red (at the sensitivity floor)
  { at: 0.2, rgb: [229, 57, 53] },    // red
  { at: 0.4, rgb: [251, 140, 0] },    // orange
  { at: 0.6, rgb: [253, 216, 53] },   // yellow
  { at: 0.8, rgb: [124, 179, 66] },   // green
  { at: 1.0, rgb: [27, 127, 59] },    // -30 dBm   dark green
];

export function rssiFraction(rssi: number): number {
  return Math.min(1, Math.max(0, (rssi - RSSI_MIN_DBM) / (RSSI_MAX_DBM - RSSI_MIN_DBM)));
}

export function rssiColor(rssi: number): string {
  const f = rssiFraction(rssi);
  let i = 0;
  while (i < RSSI_STOPS.length - 2 && f > RSSI_STOPS[i + 1].at) i++;
  const a = RSSI_STOPS[i];
  const b = RSSI_STOPS[i + 1];
  const k = (f - a.at) / (b.at - a.at);
  const [r, g, bl] = a.rgb.map((c, n) => Math.round(c + (b.rgb[n] - c) * k));
  return `rgb(${r}, ${g}, ${bl})`;
}

/** CSS gradient of the whole scale, left (weak) to right (strong). */
export const RSSI_GRADIENT = `linear-gradient(to right, ${RSSI_STOPS
  .map((s) => `rgb(${s.rgb.join(", ")}) ${s.at * 100}%`)
  .join(", ")})`;

export const RSSI_TICKS = [-107, -90, -70, -50, -30];

export interface RssiLine {
  positions: [number, number][];
  color: string;
  /** Representative RSSI of this stretch (dBm), or null for "no valid reading". */
  rssi: number | null;
}

export const NO_RSSI_COLOR = "#9AA5B1";

// The scale is cut into this many shades; neighbouring stretches with the same
// shade are drawn as one polyline, so a long flight stays light to draw.
const RSSI_LEVELS = 40;

function levelOf(rssi: number): number {
  return Math.round(rssiFraction(rssi) * (RSSI_LEVELS - 1));
}

function levelRssi(level: number): number {
  return RSSI_MIN_DBM + (level / (RSSI_LEVELS - 1)) * (RSSI_MAX_DBM - RSSI_MIN_DBM);
}

/**
 * The route as a line whose color follows the RSSI. Between two readings the color
 * fades smoothly (each leg is split into short pieces with an interpolated RSSI).
 * A leg that touches a missing reading is drawn grey, so the path stays continuous.
 */
export function rssiTrack(points: RoutePoint[], maxPieces = 8): RssiLine[] {
  const lines: RssiLine[] = [];
  if (points.length < 2) return lines;

  // Fewer pieces per leg on very long routes, to keep the number of lines bounded
  const pieces = Math.max(1, Math.min(maxPieces, Math.floor(6000 / (points.length - 1))));

  const push = (from: [number, number], to: [number, number], level: number | null) => {
    const last = lines[lines.length - 1];
    const sameShade = last && (level === null ? last.rssi === null : last.rssi === levelRssi(level));
    if (last && sameShade) {
      last.positions.push(to);
      return;
    }
    lines.push({
      positions: [from, to],
      color: level === null ? NO_RSSI_COLOR : rssiColor(levelRssi(level)),
      rssi: level === null ? null : levelRssi(level),
    });
  };

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces;
      const t1 = (k + 1) / pieces;
      const from: [number, number] = [a.lat + (b.lat - a.lat) * t0, a.lng + (b.lng - a.lng) * t0];
      const to: [number, number] = [a.lat + (b.lat - a.lat) * t1, a.lng + (b.lng - a.lng) * t1];
      if (a.rssi === null || b.rssi === null) {
        push(from, to, null);
      } else {
        const mid = a.rssi + (b.rssi - a.rssi) * ((t0 + t1) / 2);
        push(from, to, levelOf(mid));
      }
    }
  }
  return lines;
}

export function rssiStats(points: RoutePoint[]): { min: number; max: number; mean: number } | null {
  const values = points.map((p) => p.rssi).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, v) => sum + v, 0) / values.length,
  };
}

/** Points from a backend that predates RSSI recording carry no `rssi`. */
export function normalizeRoutePoint(raw: Omit<RoutePoint, "rssi"> & { rssi?: number | null }): RoutePoint {
  return { ...raw, rssi: typeof raw.rssi === "number" && Number.isFinite(raw.rssi) ? raw.rssi : null };
}

export const ROUTE_COLORS: Record<RouteLink, string> = {
  halow: "#1E88FF",
  elink: "#FFC400",
};

export const ROUTE_LABELS: Record<RouteLink, string> = {
  halow: "HaLow GNSS",
  elink: "E-Link only",
};

export interface RouteRun {
  link: RouteLink;
  positions: [number, number][];
}

/**
 * Group consecutive points of the same link into runs, so the route can be drawn
 * as a few colored polylines. A run starts at the last point of the previous one,
 * which keeps the line continuous: each segment takes the color of its newer point.
 */
export function routeRuns(points: RoutePoint[]): RouteRun[] {
  const runs: RouteRun[] = [];
  let prev: RoutePoint | null = null;
  for (const p of points) {
    const last = runs[runs.length - 1];
    if (!last || last.link !== p.link) {
      runs.push({
        link: p.link,
        positions: prev ? [[prev.lat, prev.lng], [p.lat, p.lng]] : [[p.lat, p.lng]],
      });
    } else {
      last.positions.push([p.lat, p.lng]);
    }
    prev = p;
  }
  return runs;
}

export function routeCounts(points: RoutePoint[]): Record<RouteLink, number> {
  let halow = 0;
  for (const p of points) if (p.link === "halow") halow++;
  return { halow, elink: points.length - halow };
}
