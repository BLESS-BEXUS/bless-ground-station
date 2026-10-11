// TEMP-SIM: temporary demo flight for the map pages.
// To remove it: delete this file and src/hooks/useMapSimulation.ts, and remove the
// lines marked TEMP-SIM in src/pages/MapPage.tsx. Nothing else depends on it.
import type { RouteLink, RoutePoint } from "./route";

export const SIM_ELINK_PACKETS = 15;
export const SIM_HALOW_PACKETS = 7;

const SIM_DURATION_S = 140;      // simulated seconds covered by the demo flight
const ELINK_PERIOD_S = 10;
const HALOW_PERIOD_S = 10;
const HALOW_OFFSET_S = 5;        // HaLow packets fall between the E-Link ones
const HALOW_WINDOW_S = 30;       // same rule the backend route tracker applies

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Deterministic pseudo-noise in [-1, 1], so the demo looks the same every time. */
function noise(index: number): number {
  const x = Math.sin(index * 12.9898 + 4.1) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * A made-up BEXUS-like flight: the payload climbs from next to the ground station
 * to ~25 km while drifting ~38 km to the north-east. RSSI follows free-space loss
 * (anchored to the −57 dBm seen at 1.3 km in the field logs), with a dip while the
 * balloon swings through an antenna null and a weaker tail at the far end where
 * HaLow stops arriving and only E-Link remains.
 */
export function buildSimulationRoute(gs: { lat: number; lng: number; alt: number }): RoutePoint[] {
  const events: { t: number; via: RouteLink }[] = [];
  for (let i = 0; i < SIM_ELINK_PACKETS; i++) events.push({ t: i * ELINK_PERIOD_S, via: "elink" });
  for (let j = 0; j < SIM_HALOW_PACKETS; j++) events.push({ t: HALOW_OFFSET_S + j * HALOW_PERIOD_S, via: "halow" });
  events.sort((a, b) => a.t - b.t || (a.via === "halow" ? -1 : 1));

  const base = Date.now();
  let lastHalowT = -Infinity;

  return events.map((event, index) => {
    const s = Math.min(1, event.t / SIM_DURATION_S);
    if (event.via === "halow") lastHalowT = event.t;
    const link: RouteLink = event.t - lastHalowT <= HALOW_WINDOW_S ? "halow" : "elink";

    // drifts and climbs slowly at first (close to the station, strong signal), then faster
    const groundKm = 0.05 + 38 * s ** 1.3;
    const climbM = 30 + 25_500 * s ** 1.5;
    const bearing = ((70 + 18 * Math.sin(3.1 * s)) * Math.PI) / 180;
    const lat = gs.lat + (groundKm * Math.cos(bearing)) / 111.32;
    const lng = gs.lng + (groundKm * Math.sin(bearing)) / (111.32 * Math.cos((gs.lat * Math.PI) / 180));

    const slantKm = Math.max(0.05, Math.hypot(groundKm, climbM / 1000));
    const freeSpace = -57 - 20 * Math.log10(slantKm / 1.3);
    const dip = -8 * Math.exp(-(((s - 0.42) / 0.05) ** 2));
    const tail = -10 * smoothstep(0.65, 1, s);
    const rssi = Math.round(Math.min(-30, Math.max(-104, freeSpace + dip + tail + 1.3 * noise(index))));

    return {
      lat,
      lng,
      alt: Math.round(gs.alt + climbM),
      t: base + event.t * 1000,
      link,
      pkt: index,
      rssi,
    };
  });
}
