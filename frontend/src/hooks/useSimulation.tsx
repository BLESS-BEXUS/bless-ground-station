import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";

export interface TelemetryData {
  latitude: number;
  longitude: number;
  altitude: number;
  internalTemp: number;
  externalTemp: number;
  batteryVoltage: number;
  rssi: number;
  halowStatus: "ACTIVE" | "DEGRADED" | "INTERRUPTED";
  missionPhase: "PRE-FLIGHT" | "ASCENT" | "FLOAT" | "DESCENT" | "RECOVERY";
  elapsedSeconds: number;
  rssiHistory: { time: number; rssi: number }[];
  trajectoryHistory: { lat: number; lng: number }[];
}

export const GROUND_STATION = { lat: 40.4168, lng: -3.7038, name: "Madrid GS" };

const INITIAL_BALLOON = { lat: 40.42, lng: -3.70 };

function getPhase(elapsed: number): TelemetryData["missionPhase"] {
  if (elapsed < 30) return "PRE-FLIGHT";
  if (elapsed < 180) return "ASCENT";
  if (elapsed < 300) return "FLOAT";
  if (elapsed < 420) return "DESCENT";
  return "RECOVERY";
}

function getHalowStatus(rssi: number): TelemetryData["halowStatus"] {
  if (rssi > -70) return "ACTIVE";
  if (rssi > -85) return "DEGRADED";
  return "INTERRUPTED";
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function calculateAzimuthElevation(
  balloonLat: number, balloonLng: number, balloonAlt: number,
  gsLat: number, gsLng: number
) {
  const dLng = ((balloonLng - gsLng) * Math.PI) / 180;
  const lat1 = (gsLat * Math.PI) / 180;
  const lat2 = (balloonLat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  let azimuth = (Math.atan2(y, x) * 180) / Math.PI;
  if (azimuth < 0) azimuth += 360;

  const dist = haversineDistance(gsLat, gsLng, balloonLat, balloonLng) * 1000;
  const elevation = (Math.atan2(balloonAlt, dist) * 180) / Math.PI;

  return { azimuth, elevation: Math.max(0, Math.min(90, elevation)) };
}

const SimulationContext = createContext<TelemetryData | null>(null);

export function SimulationProvider({ children }: { children: React.ReactNode }) {
  const tickRef = useRef(0);
  const [data, setData] = useState<TelemetryData>(() => ({
    latitude: INITIAL_BALLOON.lat,
    longitude: INITIAL_BALLOON.lng,
    altitude: 0,
    internalTemp: 22,
    externalTemp: 15,
    batteryVoltage: 12.6,
    rssi: -55,
    halowStatus: "ACTIVE",
    missionPhase: "PRE-FLIGHT",
    elapsedSeconds: 0,
    rssiHistory: [],
    trajectoryHistory: [{ lat: INITIAL_BALLOON.lat, lng: INITIAL_BALLOON.lng }],
  }));

  const tick = useCallback(() => {
    tickRef.current += 1;
    const t = tickRef.current;
    const elapsed = t * 2;
    const phase = getPhase(elapsed);

    let altitudeDelta = 0;
    let latDelta = 0;
    let lngDelta = 0;

    if (phase === "ASCENT") {
      altitudeDelta = 300 + Math.random() * 100;
      latDelta = 0.002 + Math.random() * 0.001;
      lngDelta = 0.001 + Math.random() * 0.001;
    } else if (phase === "FLOAT") {
      altitudeDelta = (Math.random() - 0.5) * 50;
      latDelta = 0.001 + Math.random() * 0.0005;
      lngDelta = 0.0005 + Math.random() * 0.0005;
    } else if (phase === "DESCENT") {
      altitudeDelta = -(400 + Math.random() * 100);
      latDelta = 0.001;
      lngDelta = 0.0005;
    }

    setData((prev) => {
      const newAlt = Math.max(0, prev.altitude + altitudeDelta);
      const newLat = prev.latitude + latDelta;
      const newLng = prev.longitude + lngDelta;
      const baseRssi = phase === "FLOAT" ? -75 : phase === "DESCENT" ? -80 : -60;
      const newRssi = baseRssi + (Math.random() - 0.5) * 20;
      const extTemp = phase === "ASCENT" ? prev.externalTemp - 2 : phase === "DESCENT" ? prev.externalTemp + 2 : prev.externalTemp + (Math.random() - 0.5);
      const battV = Math.max(10, prev.batteryVoltage - 0.005 - Math.random() * 0.003);

      const newRssiHistory = [...prev.rssiHistory, { time: elapsed, rssi: newRssi }].slice(-60);
      const newTrajectory = [...prev.trajectoryHistory, { lat: newLat, lng: newLng }];

      return {
        latitude: newLat,
        longitude: newLng,
        altitude: newAlt,
        internalTemp: 22 + (Math.random() - 0.5) * 2,
        externalTemp: Math.max(-60, Math.min(20, extTemp)),
        batteryVoltage: battV,
        rssi: newRssi,
        halowStatus: getHalowStatus(newRssi),
        missionPhase: phase,
        elapsedSeconds: elapsed,
        rssiHistory: newRssiHistory,
        trajectoryHistory: newTrajectory,
      };
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(tick, 2000);
    return () => clearInterval(interval);
  }, [tick]);

  return <SimulationContext.Provider value={data}>{children}</SimulationContext.Provider>;
}

export function useSimulation() {
  const ctx = useContext(SimulationContext);
  if (!ctx) throw new Error("useSimulation must be inside SimulationProvider");
  return ctx;
}

export { haversineDistance };
