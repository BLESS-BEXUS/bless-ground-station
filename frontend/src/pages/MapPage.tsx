import { memo, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useLiveData } from "@/hooks/useLiveData";
import { useMapSimulation } from "@/hooks/useMapSimulation"; // TEMP-SIM
import { SIM_ELINK_PACKETS, SIM_HALOW_PACKETS } from "@/lib/mapSimulation"; // TEMP-SIM
import { TILE_URL } from "@/lib/backendUrl";
import { fmt, NO_DATA } from "@/lib/format";
import {
  ROUTE_COLORS, ROUTE_LABELS, RSSI_GRADIENT, RSSI_MAX_DBM, RSSI_MIN_DBM, RSSI_TICKS,
  routeCounts, routeRuns, rssiFraction, rssiStats, rssiTrack, type RoutePoint,
} from "@/lib/route";

type MapMode = "standard" | "rssi";

const MAP_MODES: { id: MapMode; label: string }[] = [
  { id: "standard", label: "Standard" },
  { id: "rssi", label: "RSSI heat map" },
];

// 1×1 transparent PNG, shown instead of a broken-image icon for tiles that are not cached yet
const BLANK_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Slant range (straight line GS→balloon, accounting for altitude) */
function slantRangeKm(lat1: number, lon1: number, alt1m: number, lat2: number, lon2: number, alt2m: number): number {
  const groundKm = haversineKm(lat1, lon1, lat2, lon2);
  const altDiffKm = (alt2m - alt1m) / 1000;
  return Math.sqrt(groundKm ** 2 + altDiffKm ** 2);
}

const balloonIcon = L.divIcon({
  html: `<div style="width:14px;height:14px;background:#A5BB86;border-radius:50%;border:2px solid #183054;box-shadow:0 0 10px #A5BB86;"></div>`,
  iconSize: [14, 14], iconAnchor: [7, 7], className: "",
});

const gsIcon = L.divIcon({
  html: `<div style="width:16px;height:16px;background:#28808D;border-radius:3px;border:2px solid #183054;box-shadow:0 0 10px #28808D;"></div>`,
  iconSize: [16, 16], iconAnchor: [8, 8], className: "",
});

function MapFollower({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { map.setView([lat, lng], 10); first.current = false; }
    else map.panTo([lat, lng]);
  }, [lat, lng, map]);
  return null;
}

/** Re-measure the map whenever its container changes size (layout, sidebar, window). */
function MapAutoResize() {
  const map = useMap();
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

/** Fit the whole route (and the ground station) in view. */
function FitRoute({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length > 0) map.fitBounds(L.latLngBounds(points), { padding: [60, 60] });
  }, [map, points]);
  return null;
}

// Style objects live outside the components so react-leaflet sees the same identity
// on every render and does not restyle thousands of lines once a second.
const CASING_STYLE = { color: "#0B1B33", weight: 7, opacity: 0.55, lineCap: "round", lineJoin: "round" } as const;
const HEAT_CASING_STYLE = { color: "#0B1B33", weight: 11, opacity: 0.55, lineCap: "round", lineJoin: "round" } as const;
const RUN_STYLE = {
  halow: { color: ROUTE_COLORS.halow, weight: 4, opacity: 1, lineCap: "round", lineJoin: "round" },
  elink: { color: ROUTE_COLORS.elink, weight: 4, opacity: 1, lineCap: "round", lineJoin: "round" },
} as const;

/**
 * The recorded route. Memoized: it only redraws when the route or the mode changes,
 * not on the once-a-second connection updates that re-render the page.
 */
const RouteLayers = memo(function RouteLayers({ route, rssiMode }: { route: RoutePoint[]; rssiMode: boolean }) {
  const runs = useMemo(() => routeRuns(route), [route]);
  const heatLines = useMemo(() => (rssiMode ? rssiTrack(route) : []), [route, rssiMode]);
  const path = useMemo(
    () => (rssiMode ? route.map((p): [number, number] => [p.lat, p.lng]) : []),
    [route, rssiMode],
  );
  const heatStyles = useMemo(
    () => heatLines.map((line) => ({ color: line.color, weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" }) as const),
    [heatLines],
  );

  if (!rssiMode) {
    return (
      <>
        {/* Standard route: dark casing for contrast, then each run in its link color */}
        {runs.map((run, i) => (
          <Polyline key={`casing-${i}`} positions={run.positions} pathOptions={CASING_STYLE} />
        ))}
        {runs.map((run, i) => (
          <Polyline key={`run-${i}`} positions={run.positions} pathOptions={RUN_STYLE[run.link]} />
        ))}
      </>
    );
  }

  return (
    <>
      {/* RSSI heat map: the line itself changes color with the signal strength */}
      {path.length > 1 && <Polyline positions={path} pathOptions={HEAT_CASING_STYLE} />}
      {heatLines.map((line, i) => (
        <Polyline key={`heat-${i}`} positions={line.positions} pathOptions={heatStyles[i]}>
          <Tooltip sticky>
            {line.rssi === null ? "No valid RSSI reading" : `≈ ${Math.round(line.rssi)} dBm`}
          </Tooltip>
        </Polyline>
      ))}
    </>
  );
});

export default function MapPage() {
  const { telemetry: liveTelemetry, groundStation, route: liveRoute, clearRoute } = useLiveData();
  const [mapMode, setMapMode] = useState<MapMode>("standard");

  // TEMP-SIM: demo flight (15 E-Link + 7 HaLow packets) replaces the live data while it runs
  const simulation = useMapSimulation(groundStation);
  const simLast = simulation.route?.[simulation.route.length - 1] ?? null;
  const route = simulation.route ?? liveRoute;
  const sim = simLast
    ? {
        ...liveTelemetry,
        latitude: simLast.lat,
        longitude: simLast.lng,
        altitude: simLast.alt,
        gpsFix: true,
        gpsSats: 12,
        rssi: simLast.rssi,
        snr: 34,
        successRate: 100,
        packetCount: simulation.route?.length ?? 0,
        halowStatus: (simLast.link === "halow" ? "ACTIVE" : "INTERRUPTED") as "ACTIVE" | "INTERRUPTED",
      }
    : liveTelemetry;
  // TEMP-SIM end

  const balloon: [number, number] | null =
    sim.latitude !== null && sim.longitude !== null ? [sim.latitude, sim.longitude] : null;
  const groundDist = balloon
    ? haversineKm(balloon[0], balloon[1], groundStation.lat, groundStation.lng)
    : null;
  const slantDist = balloon
    ? slantRangeKm(groundStation.lat, groundStation.lng, groundStation.alt,
        balloon[0], balloon[1], sim.altitude ?? groundStation.alt)
    : null;

  const rssiMode = mapMode === "rssi";
  const counts = useMemo(() => routeCounts(route), [route]);
  const rssiSummary = useMemo(() => (rssiMode ? rssiStats(route) : null), [route, rssiMode]);

  // TEMP-SIM: frame the whole demo flight once, not on every render
  const simulationFrame = useMemo(
    () => [
      [groundStation.lat, groundStation.lng] as [number, number],
      ...simulation.full.map((p): [number, number] => [p.lat, p.lng]),
    ],
    [simulation.full, groundStation.lat, groundStation.lng],
  );

  function confirmClearRoute() {
    if (route.length === 0) return;
    if (window.confirm(`Clear the recorded route (${route.length} points)? This cannot be undone.`)) {
      void clearRoute();
    }
  }

  const losLine: [number, number][] | null = balloon
    ? [balloon, [groundStation.lat, groundStation.lng]]
    : null;
  const mapCenter: [number, number] = balloon ?? [groundStation.lat, groundStation.lng];

  return (
    <div className="flex h-[calc(100vh-57px)]">
      {/* Sidebar */}
      <div className="w-80 border-r border-border bg-card p-5 space-y-5 flex-shrink-0 overflow-y-auto">
        <h2 className="font-mono text-sm text-primary uppercase tracking-wider text-glow-primary">Tracking Data</h2>

        <div className="space-y-3">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Balloon Position</div>
          <DataRow label="Latitude" value={fmt(sim.latitude, 6, "°")} />
          <DataRow label="Longitude" value={fmt(sim.longitude, 6, "°")} />
          <DataRow label="Altitude" value={fmt(sim.altitude, 0, "m")} />
          <DataRow
            label="GPS Fix"
            value={sim.gpsFix === null ? NO_DATA : sim.gpsFix ? `YES (${sim.gpsSats} sats)` : "NO FIX"}
            warn={sim.gpsFix === false}
          />
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Ground Station</div>
          <DataRow label="Location" value={groundStation.name} />
          <DataRow label="Latitude" value={groundStation.lat.toFixed(6) + "°"} />
          <DataRow label="Longitude" value={groundStation.lng.toFixed(6) + "°"} />
          <DataRow label="Altitude" value={groundStation.alt + " m"} />
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Link Geometry</div>
          <DataRow label="Ground dist." value={fmt(groundDist, 2, "km")} accent />
          <DataRow label="Slant range" value={fmt(slantDist, 2, "km")} accent />
          <DataRow label="Phase" value={sim.halowStatus ?? NO_DATA} />
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Route</div>
          <DataRow label="Points" value={route.length.toString()} />
          <DataRow label={ROUTE_LABELS.halow} value={counts.halow.toString()} />
          <DataRow label={ROUTE_LABELS.elink} value={counts.elink.toString()} />
          {rssiMode && (
            <>
              <DataRow label="RSSI min" value={fmt(rssiSummary?.min ?? null, 0, "dBm")} />
              <DataRow label="RSSI mean" value={fmt(rssiSummary?.mean ?? null, 1, "dBm")} />
              <DataRow label="RSSI max" value={fmt(rssiSummary?.max ?? null, 0, "dBm")} />
            </>
          )}
          <button
            onClick={confirmClearRoute}
            disabled={route.length === 0 || simulation.active /* TEMP-SIM */}
            className="w-full px-3 py-1.5 rounded-lg border border-border font-mono text-xs text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-all disabled:opacity-40 disabled:hover:text-muted-foreground disabled:hover:border-border"
          >
            Clear route
          </button>
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          <div className="text-xs font-mono text-muted-foreground uppercase tracking-wider">RF</div>
          <DataRow label="RSSI" value={fmt(sim.rssi, 1, "dBm")} />
          <DataRow label="SNR" value={fmt(sim.snr, 1, "dB")} />
          <DataRow label="PDR" value={fmt(sim.successRate, 0, "%")} />
          <DataRow label="Packets RX" value={fmt(sim.packetCount, 0)} />
        </div>
      </div>

      {/* Map */}
      {/* `isolate`: Leaflet's panes use z-index 400-1000, which would otherwise paint over
          the dialogs of the top bar (serial port, mission clock). */}
      <div className="flex-1 relative isolate" style={{ minHeight: "400px" }}>
        {/* Map mode: the standard map is the default */}
        <div className="absolute top-4 left-4 z-[1000] flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border overflow-hidden bg-card/90 font-mono text-xs">
            {MAP_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMapMode(m.id)}
                className={`px-3 py-1.5 transition-all ${
                  mapMode === m.id
                    ? "bg-primary/25 text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* TEMP-SIM: demo flight button */}
          <button
            onClick={simulation.active ? simulation.stop : simulation.start}
            title="Temporary demo: draws a made-up flight so both maps can be seen in action"
            className={`px-3 py-1.5 rounded-lg border font-mono text-xs transition-all ${
              simulation.active
                ? "border-warning/60 bg-warning/20 text-warning"
                : "border-border bg-card/90 text-muted-foreground hover:text-foreground hover:bg-muted/30"
            }`}
          >
            {simulation.active
              ? `■ Stop simulation (${simulation.route?.length ?? 0}/${simulation.total})`
              : `▶ Simulate ${SIM_ELINK_PACKETS} E-Link + ${SIM_HALOW_PACKETS} HaLow`}
          </button>
        </div>

        {/* Legend */}
        {rssiMode ? (
          <div className="absolute top-4 right-4 z-[1000] w-64 rounded-lg border border-border bg-card/90 px-3 py-2 font-mono text-xs space-y-1.5">
            <div className="text-foreground font-semibold">RSSI (dBm)</div>
            <div className="h-3 rounded-full border border-border" style={{ background: RSSI_GRADIENT }} />
            <div className="relative h-4 text-muted-foreground">
              {RSSI_TICKS.map((tick) => (
                <span
                  key={tick}
                  className="absolute"
                  style={{
                    left: `${rssiFraction(tick) * 100}%`,
                    // keep the end labels inside the box
                    transform: `translateX(${tick === RSSI_MIN_DBM ? "-10%" : tick === RSSI_MAX_DBM ? "-90%" : "-50%"})`,
                  }}
                >
                  {tick}
                </span>
              ))}
            </div>
            <div className="text-muted-foreground leading-snug">
              {RSSI_MIN_DBM} dBm = MM6108 sensitivity (link lost below). Grey line = no valid reading.
            </div>
          </div>
        ) : (
          <div className="absolute top-4 right-4 z-[1000] rounded-lg border border-border bg-card/90 px-3 py-2 space-y-1 font-mono text-xs">
            {(["halow", "elink"] as const).map((link) => (
              <div key={link} className="flex items-center gap-2 text-foreground">
                <span
                  className="inline-block h-1.5 w-6 rounded-full"
                  style={{ backgroundColor: ROUTE_COLORS[link] }}
                />
                {ROUTE_LABELS[link]}
              </div>
            ))}
          </div>
        )}

        <MapContainer
          center={mapCenter}
          zoom={10}
          preferCanvas
          style={{ height: "100%", width: "100%" }}
          zoomControl={false}
        >
          <TileLayer
            url={TILE_URL}
            attribution="&copy; OpenStreetMap contributors"
            maxZoom={19}
            errorTileUrl={BLANK_TILE}
          />
          <MapAutoResize />
          {/* TEMP-SIM: while the demo runs the map frames the whole flight instead of following */}
          {simulation.active && (
            <FitRoute points={simulationFrame} />
          )}
          {balloon && !simulation.active && <MapFollower lat={balloon[0]} lng={balloon[1]} />}
          {balloon && (
            <Marker position={balloon} icon={balloonIcon}>
              <Popup>
                <b>Balloon</b><br />
                Alt: {fmt(sim.altitude, 0, "m")}<br />
                RSSI: {fmt(sim.rssi, 1, "dBm")}
              </Popup>
            </Marker>
          )}
          <Marker position={[groundStation.lat, groundStation.lng]} icon={gsIcon}>
            <Popup>{groundStation.name}</Popup>
          </Marker>
          <RouteLayers route={route} rssiMode={rssiMode} />
          {losLine && (
            <Polyline positions={losLine} pathOptions={{ color: "#6AB1A7", weight: 1, dashArray: "8 4", opacity: 0.5 }} />
          )}
        </MapContainer>
      </div>
    </div>
  );
}

function DataRow({ label, value, accent, warn }: {
  label: string; value: string; accent?: boolean; warn?: boolean;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm font-semibold ${
        warn ? "text-destructive" : accent ? "text-tertiary text-glow-tertiary" : "text-foreground"
      }`}>
        {value}
      </span>
    </div>
  );
}
