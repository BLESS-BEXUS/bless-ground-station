import { useEffect, useState } from "react";
import { useLiveData } from "@/hooks/useLiveData";
import { fmt } from "@/lib/format";

// ─── WGS84 / ECEF / LTC pointing computation ─────────────────────────────────
// Implements the BEXUS User Manual Chapter 10 coordinate system.

const WGS84_A = 6_378_137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = 2 * WGS84_F - WGS84_F ** 2;

function geodToEcef(latDeg: number, lonDeg: number, altM: number): [number, number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
  const x = (N + altM) * Math.cos(lat) * Math.cos(lon);
  const y = (N + altM) * Math.cos(lat) * Math.sin(lon);
  const z = (N * (1 - WGS84_E2) + altM) * Math.sin(lat);
  return [x, y, z];
}

export interface PointingResult {
  azimuth: number;
  elevation: number;
  slantRangeKm: number;
}

/**
 * Compute Az/El/slant-range from GS to balloon using LTC frame (BEXUS UM §10).
 * azimuth: 0-360° clockwise from North
 * elevation: -90..90° from the local horizon (negative = target below horizon)
 */
export function computePointingLTC(
  gsLat: number, gsLon: number, gsAlt: number,
  balloonLat: number, balloonLon: number, balloonAlt: number,
): PointingResult {
  const [xGs, yGs, zGs] = geodToEcef(gsLat, gsLon, gsAlt);
  const [xBal, yBal, zBal] = geodToEcef(balloonLat, balloonLon, balloonAlt);

  const dx = xBal - xGs;
  const dy = yBal - yGs;
  const dz = zBal - zGs;

  const lat = (gsLat * Math.PI) / 180;
  const lon = (gsLon * Math.PI) / 180;

  // Rotation matrix ECEF → LTC (N, E, U)
  const north = [
    -Math.sin(lat) * Math.cos(lon),
    -Math.sin(lat) * Math.sin(lon),
    Math.cos(lat),
  ];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const up = [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];

  const n = north[0] * dx + north[1] * dy + north[2] * dz;
  const e = east[0] * dx + east[1] * dy + east[2] * dz;
  const u = up[0] * dx + up[1] * dy + up[2] * dz;

  let azimuth = (Math.atan2(e, n) * 180) / Math.PI;
  if (azimuth < 0) azimuth += 360;

  const horizDist = Math.sqrt(n ** 2 + e ** 2);
  const elevation = (Math.atan2(u, horizDist) * 180) / Math.PI;
  const slantRangeKm = Math.sqrt(dx ** 2 + dy ** 2 + dz ** 2) / 1000;

  return { azimuth, elevation, slantRangeKm };
}

// ─── Visuals ─────────────────────────────────────────────────────────────────

function CompassVisual({ azimuth }: { azimuth: number | null }) {
  return (
    <div className="relative w-52 h-52 mx-auto">
      <svg viewBox="0 0 200 200" className="w-full h-full">
        <circle cx="100" cy="100" r="95" fill="none" stroke="#28808D44" strokeWidth="2" />
        <circle cx="100" cy="100" r="90" fill="none" stroke="#28808D22" strokeWidth="1" />
        {[
          { label: "N", angle: 0, color: "#E05555" },
          { label: "E", angle: 90, color: "#E1DFB4aa" },
          { label: "S", angle: 180, color: "#E1DFB4aa" },
          { label: "W", angle: 270, color: "#E1DFB4aa" },
        ].map(({ label, angle, color }) => {
          const rad = ((angle - 90) * Math.PI) / 180;
          return (
            <text key={label} x={100 + 80 * Math.cos(rad)} y={100 + 80 * Math.sin(rad)}
              textAnchor="middle" dominantBaseline="central"
              fill={color} fontSize="13" fontFamily="JetBrains Mono" fontWeight="bold">
              {label}
            </text>
          );
        })}
        {Array.from({ length: 72 }).map((_, i) => {
          const angle = i * 5;
          const rad = ((angle - 90) * Math.PI) / 180;
          const isMajor = angle % 45 === 0;
          const r1 = isMajor ? 60 : 64;
          return (
            <line key={i}
              x1={100 + r1 * Math.cos(rad)} y1={100 + r1 * Math.sin(rad)}
              x2={100 + 70 * Math.cos(rad)} y2={100 + 70 * Math.sin(rad)}
              stroke="#28808D55" strokeWidth={isMajor ? 2 : 1}
            />
          );
        })}
        {/* Pointer */}
        {azimuth !== null && (
          <line
            x1="100" y1="100"
            x2={100 + 62 * Math.cos(((azimuth - 90) * Math.PI) / 180)}
            y2={100 + 62 * Math.sin(((azimuth - 90) * Math.PI) / 180)}
            stroke="#28808D" strokeWidth="3" strokeLinecap="round"
            style={{ filter: "drop-shadow(0 0 6px #28808D99)" }}
          />
        )}
        <circle cx="100" cy="100" r="5" fill="#28808D" />
        <text x="100" y="100" textAnchor="middle" dominantBaseline="central"
          fill="#28808D" fontSize="9" fontFamily="JetBrains Mono" dy="14">
          {azimuth === null ? "—" : `${azimuth.toFixed(1)}°`}
        </text>
      </svg>
    </div>
  );
}

function ElevationArc({ elevation }: { elevation: number | null }) {
  return (
    <div className="relative w-52 h-32 mx-auto">
      <svg viewBox="0 0 200 130" className="w-full h-full">
        <path d="M 15 115 A 85 85 0 0 1 185 115" fill="none" stroke="#6AB1A744" strokeWidth="2" />
        {[0, 15, 30, 45, 60, 75, 90].map((deg) => {
          const rad = ((180 - deg) * Math.PI) / 180;
          const cx = 100, cy = 115, r = 85;
          return (
            <g key={deg}>
              <line
                x1={cx + (r - 8) * Math.cos(rad)} y1={cy - (r - 8) * Math.sin(rad)}
                x2={cx + r * Math.cos(rad)} y2={cy - r * Math.sin(rad)}
                stroke="#6AB1A755" strokeWidth="1"
              />
              <text
                x={cx + (r + 14) * Math.cos(rad)} y={cy - (r + 14) * Math.sin(rad)}
                textAnchor="middle" dominantBaseline="central"
                fill="#E1DFB4aa" fontSize="9" fontFamily="JetBrains Mono">
                {deg}°
              </text>
            </g>
          );
        })}
        {/* Horizon */}
        <line x1="15" y1="115" x2="185" y2="115" stroke="#6AB1A733" strokeWidth="1" />
        {elevation !== null && (() => {
          // Value shown is the real one; only the drawn needle is limited to what fits the viewBox
          const drawn = Math.max(-12, Math.min(90, elevation));
          const rad = ((180 - drawn) * Math.PI) / 180;
          const cx = 100, cy = 115, r = 72;
          return (
            <>
              <line x1={cx} y1={cy}
                x2={cx + r * Math.cos(rad)} y2={cy - r * Math.sin(rad)}
                stroke="#6AB1A7" strokeWidth="3" strokeLinecap="round"
                style={{ filter: "drop-shadow(0 0 6px #6AB1A799)" }}
              />
              <circle cx={cx} cy={cy} r="4" fill="#6AB1A7" />
            </>
          );
        })()}
      </svg>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AntennaPage() {
  const { telemetry: sim, groundStation, setGroundStation } = useLiveData();

  // Configurable GS coordinates (default = GROUND_STATION constant)
  const [gsLat, setGsLat] = useState(groundStation.lat.toString());
  const [gsLon, setGsLon] = useState(groundStation.lng.toString());
  const [gsAlt, setGsAlt] = useState(groundStation.alt.toString());

  // Follow coordinates saved from another browser tab; keep what is being typed otherwise.
  useEffect(() => {
    const sync = (text: string, saved: number) =>
      text.trim() !== "" && Number(text) === saved ? text : saved.toString();
    setGsLat((t) => sync(t, groundStation.lat));
    setGsLon((t) => sync(t, groundStation.lng));
    setGsAlt((t) => sync(t, groundStation.alt));
  }, [groundStation.lat, groundStation.lng, groundStation.alt]);

  const parsedLat = Number.isFinite(parseFloat(gsLat)) ? parseFloat(gsLat) : groundStation.lat;
  const parsedLon = Number.isFinite(parseFloat(gsLon)) ? parseFloat(gsLon) : groundStation.lng;
  const parsedAlt = Number.isFinite(parseFloat(gsAlt)) ? parseFloat(gsAlt) : groundStation.alt;

  const pointing = sim.latitude !== null && sim.longitude !== null && sim.altitude !== null
    ? computePointingLTC(
        parsedLat, parsedLon, parsedAlt,
        sim.latitude, sim.longitude, sim.altitude,
      )
    : null;
  const azimuth = pointing?.azimuth ?? null;
  const elevation = pointing?.elevation ?? null;
  const slantRangeKm = pointing?.slantRangeKm ?? null;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">

      {/* Instruction banner */}
      <div className="rounded-lg border border-tertiary/30 bg-card p-4">
        <p className="font-mono text-sm text-tertiary">
          Point antenna to the indicated azimuth and elevation to track the balloon.
          Update GS coordinates below to match your exact antenna position.
        </p>
      </div>

      {/* Main Az/El display */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-card p-6 text-center space-y-3">
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Azimuth</span>
          <div className="font-mono text-6xl font-bold text-primary text-glow-primary">
            {azimuth === null ? "—" : `${azimuth.toFixed(1)}°`}
          </div>
          <CompassVisual azimuth={azimuth} />
        </div>

        <div className="rounded-lg border border-border bg-card p-6 text-center space-y-3">
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Elevation</span>
          <div className="font-mono text-6xl font-bold text-tertiary text-glow-tertiary">
            {elevation === null ? "—" : `${elevation.toFixed(1)}°`}
          </div>
          <ElevationArc elevation={elevation} />
        </div>
      </div>

      {/* Slant range */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-1">Slant Range</div>
          <div className="font-mono text-2xl font-bold text-secondary">{fmt(slantRangeKm, 2, "km")}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-1">Balloon Alt.</div>
          <div className="font-mono text-2xl font-bold text-foreground">{fmt(sim.altitude, 0, "m")}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-1">RSSI</div>
          <div className={`font-mono text-2xl font-bold ${
            sim.halowStatus === "ACTIVE" ? "text-success"
            : sim.halowStatus === "DEGRADED" ? "text-warning"
            : sim.halowStatus === "INTERRUPTED" ? "text-destructive"
            : "text-muted-foreground"
          }`}>{fmt(sim.rssi, 1, "dBm")}</div>
        </div>
      </div>

      {/* GS coordinate config */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-widest">
          Ground Station Coordinates — set your exact antenna position
        </h3>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "GS Latitude (°N)", val: gsLat, set: setGsLat, field: "lat" as const, placeholder: "67.8856" },
            { label: "GS Longitude (°E)", val: gsLon, set: setGsLon, field: "lng" as const, placeholder: "21.0786" },
            { label: "GS Altitude (m)", val: gsAlt, set: setGsAlt, field: "alt" as const, placeholder: "310" },
          ].map(({ label, val, set, field, placeholder }) => (
            <div key={label} className="flex flex-col gap-1">
              <label className="font-mono text-xs text-muted-foreground">{label}</label>
              <input
                type="number"
                value={val}
                onChange={(e) => {
                  const value = e.target.value;
                  set(value);
                  // An empty or incomplete field must not overwrite the saved value with 0.
                  const parsed = Number(value);
                  if (value.trim() !== "" && Number.isFinite(parsed)) {
                    setGroundStation({ ...groundStation, [field]: parsed });
                  }
                }}
                placeholder={placeholder}
                className="bg-background border border-border rounded px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary/60"
                step="0.0001"
              />
            </div>
          ))}
        </div>
        <p className="font-mono text-xs text-muted-foreground/70">
          Saved automatically in this browser for {window.location.origin}. Opening the app from a
          different address or port starts again from the defaults.
        </p>
      </div>

      {/* Computation inputs summary */}
      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-widest mb-4">
          LTC Computation Inputs (WGS84 / ECEF → LTC, BEXUS UM §10)
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { label: "Balloon Lat", value: fmt(sim.latitude, 6, "°") },
            { label: "Balloon Lon", value: fmt(sim.longitude, 6, "°") },
            { label: "Balloon Alt", value: fmt(sim.altitude, 0, "m") },
            { label: "GS Lat", value: parsedLat.toFixed(6) + "°" },
            { label: "GS Lon", value: parsedLon.toFixed(6) + "°" },
            { label: "GS Alt", value: parsedAlt.toFixed(0) + " m" },
          ].map((d) => (
            <div key={d.label} className="flex justify-between items-center border-b border-border/50 pb-2">
              <span className="font-mono text-xs text-muted-foreground">{d.label}</span>
              <span className="font-mono text-sm font-semibold text-foreground">{d.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
