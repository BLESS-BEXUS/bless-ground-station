import { useState } from "react";
import { useLiveData, GROUND_STATION } from "@/hooks/useLiveData";

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
 * elevation: 0-90° from horizon
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
  const elevation = Math.max(0, Math.min(90, (Math.atan2(u, horizDist) * 180) / Math.PI));
  const slantRangeKm = Math.sqrt(dx ** 2 + dy ** 2 + dz ** 2) / 1000;

  return { azimuth, elevation, slantRangeKm };
}

// ─── Visuals ─────────────────────────────────────────────────────────────────

function CompassVisual({ azimuth }: { azimuth: number }) {
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
        <line
          x1="100" y1="100"
          x2={100 + 62 * Math.cos(((azimuth - 90) * Math.PI) / 180)}
          y2={100 + 62 * Math.sin(((azimuth - 90) * Math.PI) / 180)}
          stroke="#28808D" strokeWidth="3" strokeLinecap="round"
          style={{ filter: "drop-shadow(0 0 6px #28808D99)" }}
        />
        <circle cx="100" cy="100" r="5" fill="#28808D" />
        <text x="100" y="100" textAnchor="middle" dominantBaseline="central"
          fill="#28808D" fontSize="9" fontFamily="JetBrains Mono" dy="14">
          {azimuth.toFixed(1)}°
        </text>
      </svg>
    </div>
  );
}

function ElevationArc({ elevation }: { elevation: number }) {
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
        {(() => {
          const rad = ((180 - elevation) * Math.PI) / 180;
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
  const { telemetry: sim } = useLiveData();

  // Configurable GS coordinates (default = GROUND_STATION constant)
  const [gsLat, setGsLat] = useState(GROUND_STATION.lat.toString());
  const [gsLon, setGsLon] = useState(GROUND_STATION.lng.toString());
  const [gsAlt, setGsAlt] = useState(GROUND_STATION.alt.toString());

  const parsedLat = parseFloat(gsLat) || GROUND_STATION.lat;
  const parsedLon = parseFloat(gsLon) || GROUND_STATION.lng;
  const parsedAlt = parseFloat(gsAlt) || GROUND_STATION.alt;

  const { azimuth, elevation, slantRangeKm } = computePointingLTC(
    parsedLat, parsedLon, parsedAlt,
    sim.latitude, sim.longitude, sim.altitude,
  );

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
            {azimuth.toFixed(1)}°
          </div>
          <CompassVisual azimuth={azimuth} />
        </div>

        <div className="rounded-lg border border-border bg-card p-6 text-center space-y-3">
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Elevation</span>
          <div className="font-mono text-6xl font-bold text-tertiary text-glow-tertiary">
            {elevation.toFixed(1)}°
          </div>
          <ElevationArc elevation={elevation} />
        </div>
      </div>

      {/* Slant range */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-1">Slant Range</div>
          <div className="font-mono text-2xl font-bold text-secondary">{slantRangeKm.toFixed(2)} km</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-1">Balloon Alt.</div>
          <div className="font-mono text-2xl font-bold text-foreground">{sim.altitude.toFixed(0)} m</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 text-center">
          <div className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-1">RSSI</div>
          <div className={`font-mono text-2xl font-bold ${
            sim.halowStatus === "ACTIVE" ? "text-success" : sim.halowStatus === "DEGRADED" ? "text-warning" : "text-destructive"
          }`}>{sim.rssi.toFixed(1)} dBm</div>
        </div>
      </div>

      {/* GS coordinate config */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-widest">
          Ground Station Coordinates — set your exact antenna position
        </h3>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: "GS Latitude (°N)", val: gsLat, set: setGsLat, placeholder: "67.8856" },
            { label: "GS Longitude (°E)", val: gsLon, set: setGsLon, placeholder: "21.0786" },
            { label: "GS Altitude (m)", val: gsAlt, set: setGsAlt, placeholder: "310" },
          ].map(({ label, val, set, placeholder }) => (
            <div key={label} className="flex flex-col gap-1">
              <label className="font-mono text-xs text-muted-foreground">{label}</label>
              <input
                type="number"
                value={val}
                onChange={(e) => set(e.target.value)}
                placeholder={placeholder}
                className="bg-background border border-border rounded px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary/60"
                step="0.0001"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Computation inputs summary */}
      <div className="rounded-lg border border-border bg-card p-5">
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-widest mb-4">
          LTC Computation Inputs (WGS84 / ECEF → LTC, BEXUS UM §10)
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { label: "Balloon Lat", value: sim.latitude.toFixed(6) + "°" },
            { label: "Balloon Lon", value: sim.longitude.toFixed(6) + "°" },
            { label: "Balloon Alt", value: sim.altitude.toFixed(0) + " m" },
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
