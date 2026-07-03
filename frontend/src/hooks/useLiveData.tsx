import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";

// ─── Shared telemetry shape ────────────────────────────────────────────────────

export interface TelemetryData {
  // GNSS
  latitude: number;
  longitude: number;
  altitude: number;
  gpsFix: boolean;
  gpsFixQuality: number; // 0=NO FIX, 1=3D FIX, 2=DGPS FIX, 3=RTK FIX
  gpsSats: number;
  // RF
  rssi: number;
  snr: number;
  freqDevHz: number;
  successRate: number;
  noiseFloor: number;
  txMcs: number;
  halowStatus: "ACTIVE" | "DEGRADED" | "INTERRUPTED";
  // Hardware
  rfVoltMv: number;
  halowCurrMa: number;
  chipTempC: number;
  heaterPower: number;
  // Environment
  pressurePa: number;
  extTempC: number;
  intTempC: number;
  extHumidityRh: number;
  radiationCps: number;
  // Meta
  timestamp: number;
  packetCount: number;
  errorFlags: number;
  receivedAt: string;
  // Derived history
  rssiHistory: { time: number; rssi: number; snr: number }[];
  trajectoryHistory: { lat: number; lng: number; alt: number }[];
  envHistory: { time: number; radiationCps: number; intTempC: number; extTempC: number; extHumidityRh: number }[];
}

export interface ConnectionState {
  wsConnected: boolean;
  serialConnected: boolean;
  serialPort: string;
  mode: "live" | "simulation";
  elinkConnected: boolean;
  elinkPort: string;
}

// Ground station — set exact coordinates for the campaign
export const GROUND_STATION = {
  lat: 67.8856,
  lng: 21.0786,
  alt: 310,
  name: "Esrange Space Center",
};

// ─── Context ──────────────────────────────────────────────────────────────────

interface LiveDataContextValue {
  telemetry: TelemetryData;
  elinkTelemetry: TelemetryData;
  connection: ConnectionState;
  logging: boolean;
  toggleLogging: () => Promise<void>;
  sendCommand: (cmd: string, params?: number[]) => Promise<{ ok: boolean; error?: string }>;
  changePort: (port: string) => Promise<{ ok: boolean; error?: string }>;
  changeElinkPort: (ip: string, port?: number) => Promise<{ ok: boolean; error?: string }>;
  listPorts: () => Promise<{ path: string; manufacturer: string }[]>;
}

const LiveDataContext = createContext<LiveDataContextValue | null>(null);

// ─── Simulation fallback ───────────────────────────────────────────────────────

function buildSimTick(prev: TelemetryData, tick: number): TelemetryData {
  const elapsed = tick * 2;
  const phase =
    elapsed < 30 ? "pre"
    : elapsed < 180 ? "ascent"
    : elapsed < 300 ? "float"
    : elapsed < 420 ? "descent"
    : "recovery";

  let altDelta = 0, latDelta = 0, lngDelta = 0;
  if (phase === "ascent") { altDelta = 300 + Math.random() * 100; latDelta = 0.002; lngDelta = 0.001; }
  else if (phase === "float") { altDelta = (Math.random() - 0.5) * 50; latDelta = 0.001; lngDelta = 0.0005; }
  else if (phase === "descent") { altDelta = -(400 + Math.random() * 100); latDelta = 0.001; lngDelta = 0.0005; }

  const newAlt = Math.max(0, prev.altitude + altDelta);
  const newLat = prev.latitude + latDelta;
  const newLng = prev.longitude + lngDelta;
  const baseRssi = phase === "float" ? -75 : phase === "descent" ? -80 : -60;
  const newRssi = baseRssi + (Math.random() - 0.5) * 20;
  const newSnr = 20 + (Math.random() - 0.5) * 10;
  const extTemp = Math.max(-60, Math.min(20, prev.extTempC + (phase === "ascent" ? -2 : phase === "descent" ? 2 : (Math.random() - 0.5))));
  const newExtTempC = +extTemp.toFixed(2);
  const newIntTempC = +(22 + (Math.random() - 0.5) * 2).toFixed(2);
  const newExtHumidityRh = +(40 + Math.random() * 10).toFixed(2);
  const newRadiationCps = Math.round(2 + newAlt / 5000);

  return {
    ...prev,
    latitude: newLat,
    longitude: newLng,
    altitude: newAlt,
    gpsFix: true,
    gpsFixQuality: 1,
    gpsSats: 8 + Math.floor(Math.random() * 4),
    rssi: newRssi,
    snr: newSnr,
    freqDevHz: Math.round((Math.random() - 0.5) * 500),
    successRate: newRssi > -80 ? 95 + Math.floor(Math.random() * 5) : 60 + Math.floor(Math.random() * 30),
    noiseFloor: -100 + Math.random() * 5,
    txMcs: newRssi > -70 ? 7 : newRssi > -85 ? 3 : 0,
    halowStatus: newRssi > -70 ? "ACTIVE" : newRssi > -85 ? "DEGRADED" : "INTERRUPTED",
    rfVoltMv: 1500 + Math.round((Math.random() - 0.5) * 200),
    halowCurrMa: 120 + Math.round((Math.random() - 0.5) * 20),
    chipTempC: +(22 + (Math.random() - 0.5) * 2).toFixed(2),
    heaterPower: phase === "ascent" || phase === "float" ? Math.round(50 + Math.random() * 50) : 0,
    pressurePa: Math.round(101325 * Math.exp(-newAlt / 8500)),
    extTempC: newExtTempC,
    intTempC: newIntTempC,
    extHumidityRh: newExtHumidityRh,
    radiationCps: newRadiationCps,
    timestamp: elapsed * 1000,
    packetCount: prev.packetCount + 1,
    errorFlags: 0,
    receivedAt: new Date().toISOString(),
    rssiHistory: [...prev.rssiHistory, { time: elapsed, rssi: newRssi, snr: newSnr }].slice(-60),
    trajectoryHistory: [...prev.trajectoryHistory, { lat: newLat, lng: newLng, alt: newAlt }],
    envHistory: [...prev.envHistory, {
      time: elapsed,
      radiationCps: newRadiationCps,
      intTempC: newIntTempC,
      extTempC: newExtTempC,
      extHumidityRh: newExtHumidityRh,
    }].slice(-60),
  };
}

const INITIAL_TELEMETRY: TelemetryData = {
  latitude: GROUND_STATION.lat + 0.05,
  longitude: GROUND_STATION.lng + 0.05,
  altitude: 0,
  gpsFix: false,
  gpsFixQuality: 0,
  gpsSats: 0,
  rssi: -55,
  snr: 25,
  freqDevHz: 0,
  successRate: 100,
  noiseFloor: -100,
  txMcs: 7,
  halowStatus: "ACTIVE",
  rfVoltMv: 1500,
  halowCurrMa: 120,
  chipTempC: 22,
  heaterPower: 0,
  pressurePa: 101325,
  extTempC: 15,
  intTempC: 22,
  extHumidityRh: 45,
  radiationCps: 2,
  timestamp: 0,
  packetCount: 0,
  errorFlags: 0,
  receivedAt: new Date().toISOString(),
  rssiHistory: [],
  trajectoryHistory: [{ lat: GROUND_STATION.lat + 0.05, lng: GROUND_STATION.lng + 0.05, alt: 0 }],
  envHistory: [],
};

// ─── Provider ─────────────────────────────────────────────────────────────────

const BACKEND_HOST = window.location.hostname;
const WS_URL = `ws://${BACKEND_HOST}:8765`;
const HTTP_URL = `http://${BACKEND_HOST}:8765`;

export function LiveDataProvider({ children }: { children: React.ReactNode }) {
  const [telemetry, setTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [elinkTelemetry, setElinkTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [logging, setLogging] = useState(false);
  const loggingRef = useRef(false);
  const [connection, setConnection] = useState<ConnectionState>({
    wsConnected: false,
    serialConnected: false,
    serialPort: "—",
    mode: "simulation",
    elinkConnected: false,
    elinkPort: "—",
  });

  const wsRef = useRef<WebSocket | null>(null);
  const simTickRef = useRef(0);
  const simIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startSim = useCallback(() => {
    if (simIntervalRef.current) return;
    simIntervalRef.current = setInterval(() => {
      simTickRef.current += 1;
      setTelemetry((prev) => buildSimTick(prev, simTickRef.current));
    }, 2000);
  }, []);

  const stopSim = useCallback(() => {
    if (simIntervalRef.current) {
      clearInterval(simIntervalRef.current);
      simIntervalRef.current = null;
    }
  }, []);

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnection((c) => ({ ...c, wsConnected: true }));
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string);

        if (msg.type === "connection") {
          const serial = msg.serial as boolean;
          setConnection((c) => ({
            ...c,
            serialConnected: serial,
            serialPort: msg.port ?? c.serialPort,
            mode: serial ? "live" : "simulation",
          }));
          if (serial) stopSim();
        }

        if (msg.type === "logging") {
          loggingRef.current = msg.active as boolean;
          setLogging(msg.active as boolean);
        }

        if (msg.type === "elink_connection") {
          setConnection((c) => ({
            ...c,
            elinkConnected: msg.connected as boolean,
            elinkPort: msg.port ?? c.elinkPort,
          }));
        }

        if (msg.type === "elink_telemetry" && msg.data) {
          const d = msg.data;
          setElinkTelemetry((prev) => {
            const lastPt = prev.trajectoryHistory[prev.trajectoryHistory.length - 1];
            const jump = lastPt && (Math.abs(lastPt.lat - d.latitude) > 1 || Math.abs(lastPt.lng - d.longitude) > 1);
            return {
              ...d,
              rssiHistory: [...(jump ? [] : prev.rssiHistory), { time: d.timestamp / 1000, rssi: d.rssi, snr: d.snr }].slice(-60),
              trajectoryHistory: [...(jump ? [] : prev.trajectoryHistory), { lat: d.latitude, lng: d.longitude, alt: d.altitude }],
              envHistory: [...(jump ? [] : prev.envHistory), {
                time: d.timestamp / 1000,
                radiationCps: d.radiationCps,
                intTempC: d.intTempC,
                extTempC: d.extTempC,
                extHumidityRh: d.extHumidityRh,
              }].slice(-60),
            };
          });
        }

        if (msg.type === "telemetry" && msg.data) {
          const d = msg.data;
          setTelemetry((prev) => {
            const lastPt = prev.trajectoryHistory[prev.trajectoryHistory.length - 1];
            const jump = lastPt && (Math.abs(lastPt.lat - d.latitude) > 1 || Math.abs(lastPt.lng - d.longitude) > 1);
            const baseTrajectory = jump ? [] : prev.trajectoryHistory;
            const baseRssi = jump ? [] : prev.rssiHistory;
            const baseEnv = jump ? [] : prev.envHistory;
            return {
              ...d,
              rssiHistory: [...baseRssi, { time: d.timestamp / 1000, rssi: d.rssi, snr: d.snr }].slice(-60),
              trajectoryHistory: [...baseTrajectory, { lat: d.latitude, lng: d.longitude, alt: d.altitude }],
              envHistory: [...baseEnv, {
                time: d.timestamp / 1000,
                radiationCps: d.radiationCps,
                intTempC: d.intTempC,
                extTempC: d.extTempC,
                extHumidityRh: d.extHumidityRh,
              }].slice(-60),
            };
          });
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onerror = () => {
      setConnection((c) => ({ ...c, wsConnected: false }));
    };

    ws.onclose = () => {
      setConnection((c) => ({ ...c, wsConnected: false }));
      setTimeout(connectWs, 3000);
    };
  }, [startSim, stopSim]);

  useEffect(() => {
    connectWs();
    return () => {
      stopSim();
      wsRef.current?.close();
    };
  }, [connectWs, startSim, stopSim]);

  const sendCommand = useCallback(
    async (cmd: string, params: number[] = []): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch(`${HTTP_URL}/cmd/${cmd}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ params }),
        });
        return await res.json();
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    []
  );

  const changePort = useCallback(async (newPort: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${HTTP_URL}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: newPort }),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, []);

  const toggleLogging = useCallback(async () => {
    const endpoint = loggingRef.current ? "/logging/stop" : "/logging/start";
    await fetch(`${HTTP_URL}${endpoint}`, { method: "POST" }).catch(() => {});
  }, []);

  const changeElinkPort = useCallback(async (ip: string, port?: number): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${HTTP_URL}/config/elink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip, port }),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, []);

  const listPorts = useCallback(async (): Promise<{ path: string; manufacturer: string }[]> => {
    try {
      const res = await fetch(`${HTTP_URL}/ports`);
      return await res.json();
    } catch {
      return [];
    }
  }, []);

  return (
    <LiveDataContext.Provider value={{ telemetry, elinkTelemetry, connection, logging, toggleLogging, sendCommand, changePort, changeElinkPort, listPorts }}>
      {children}
    </LiveDataContext.Provider>
  );
}

export function useLiveData(): LiveDataContextValue {
  const ctx = useContext(LiveDataContext);
  if (!ctx) throw new Error("useLiveData must be inside LiveDataProvider");
  return ctx;
}
