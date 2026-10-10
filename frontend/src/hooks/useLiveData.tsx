import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { LINK_FRESHNESS_MS, selectTelemetrySource } from "@/lib/linkSelection";
import {
  GROUND_STATION_STORAGE_KEY,
  loadGroundStation,
  saveGroundStation,
  type GroundStationLocation,
} from "@/lib/groundStation";

// ─── Shared telemetry shape ────────────────────────────────────────────────────
// Every value is null until the first packet arrives; the UI shows "—" for null.

export interface TelemetryData {
  // GNSS
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  gpsFix: boolean | null;
  gpsSats: number | null;
  // RF
  rssi: number | null;
  snr: number | null;
  freqDevHz: number | null;
  successRate: number | null;
  noiseFloor: number | null;
  txMcs: number | null;
  halowStatus: "ACTIVE" | "DEGRADED" | "INTERRUPTED" | null;
  // Hardware
  systemState: number | null;
  systemStateLabel: "INIT" | "IDLE" | "FLIGHT" | "UNKNOWN" | null;
  halowCurrMa: number | null;
  chipTempC: number | null;
  heaterPower: number | null;
  // Environment
  pressurePa: number | null;
  extTempC: number | null;
  intTempC: number | null;
  extHumidityRh: number | null;
  radiationCps: number | null;
  // Meta
  timestamp: number | null;
  packetCount: number | null;
  errorFlags: number | null;
  receivedAt: string | null;
  // Derived history
  rssiHistory: { time: number; rssi: number; snr: number }[];
  trajectoryHistory: { lat: number; lng: number; alt: number }[];
}

/** Which downlinks are delivering packets right now. */
export type LinkMode = "none" | "elink" | "halow" | "halow+elink";

export interface ConnectionState {
  wsConnected: boolean;
  serialConnected: boolean;
  serialPort: string;
  mode: LinkMode;
  activeSource: "elink" | "halow" | "none";
  elinkConnected: boolean;
  elinkReady: boolean;
  halowFresh: boolean;
  elinkPort: string;
}

export type { GroundStationLocation } from "@/lib/groundStation";

export interface CommandResult {
  ok: boolean;
  error?: string;
  cmd?: string;
  token?: number;
  rttMs?: number;
  from?: string;
  t0UtcApprox?: string;
  commandSentUtc?: string;
  confirmedUtc?: string;
}


// ─── Context ──────────────────────────────────────────────────────────────────

interface LiveDataContextValue {
  telemetry: TelemetryData;
  elinkTelemetry: TelemetryData;
  connection: ConnectionState;
  logging: boolean;
  groundStation: GroundStationLocation;
  setGroundStation: (location: GroundStationLocation) => void;
  toggleLogging: () => Promise<void>;
  sendCommand: (cmd: string, params?: number[]) => Promise<CommandResult>;
  changePort: (port: string) => Promise<{ ok: boolean; error?: string }>;
  changeElinkPort: (port: string) => Promise<{ ok: boolean; error?: string }>;
  listPorts: () => Promise<{ path: string; manufacturer: string }[]>;
}

const LiveDataContext = createContext<LiveDataContextValue | null>(null);

const INITIAL_TELEMETRY: TelemetryData = {
  latitude: null,
  longitude: null,
  altitude: null,
  gpsFix: null,
  gpsSats: null,
  rssi: null,
  snr: null,
  freqDevHz: null,
  successRate: null,
  noiseFloor: null,
  txMcs: null,
  halowStatus: null,
  systemState: null,
  systemStateLabel: null,
  halowCurrMa: null,
  chipTempC: null,
  heaterPower: null,
  pressurePa: null,
  extTempC: null,
  intTempC: null,
  extHumidityRh: null,
  radiationCps: null,
  timestamp: null,
  packetCount: null,
  errorFlags: null,
  receivedAt: null,
  rssiHistory: [],
  trajectoryHistory: [],
};

function mergePacket(prev: TelemetryData, d: TelemetryData): TelemetryData {
  const lat = d.latitude;
  const lng = d.longitude;
  const hasPosition = lat !== null && lng !== null;
  const lastPt = prev.trajectoryHistory[prev.trajectoryHistory.length - 1];
  const jump = Boolean(lastPt && hasPosition
    && (Math.abs(lastPt.lat - lat) > 1 || Math.abs(lastPt.lng - lng) > 1));
  const hasRf = d.rssi !== null && d.snr !== null && d.timestamp !== null;
  return {
    ...d,
    rssiHistory: hasRf
      ? [...(jump ? [] : prev.rssiHistory), {
          time: d.timestamp / 1000,
          rssi: d.rssi,
          snr: d.snr,
        }].slice(-60)
      : prev.rssiHistory,
    trajectoryHistory: hasPosition
      ? [...(jump ? [] : prev.trajectoryHistory), {
          lat,
          lng,
          alt: d.altitude ?? 0,
        }]
      : prev.trajectoryHistory,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

// Longer than the slowest downlink period (HaLow, ~10 s) so the mode does not flap.
const LIVE_TIMEOUT_MS = 30_000;

const BACKEND_HOST = window.location.hostname;
const WS_URL = `ws://${BACKEND_HOST}:8765`;
const HTTP_URL = `http://${BACKEND_HOST}:8765`;

export function LiveDataProvider({ children }: { children: React.ReactNode }) {
  const [telemetry, setTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [elinkTelemetry, setElinkTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [logging, setLogging] = useState(false);
  const [groundStation, setGroundStationState] = useState<GroundStationLocation>(loadGroundStation);
  const loggingRef = useRef(false);
  const [connection, setConnection] = useState<ConnectionState>({
    wsConnected: false,
    serialConnected: false,
    serialPort: "—",
    mode: "none",
    activeSource: "none",
    elinkConnected: false,
    elinkReady: false,
    halowFresh: false,
    elinkPort: "—",
  });

  const wsRef = useRef<WebSocket | null>(null);
  const lastElinkActivityRef = useRef(0);
  const lastElinkRxRef = useRef(0);
  const lastHalowRxRef = useRef(0);
  const latestElinkRef = useRef<TelemetryData | null>(null);
  const latestHalowRef = useRef<TelemetryData | null>(null);

  // Persist only when the operator changes the coordinates (never on mount, so a
  // tab that just loaded can't overwrite what another tab saved).
  const setGroundStation = useCallback((location: GroundStationLocation) => {
    saveGroundStation(location);
    setGroundStationState(location);
  }, []);

  // Adopt coordinates saved from another tab instead of clobbering them later.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== GROUND_STATION_STORAGE_KEY) return;
      setGroundStationState(loadGroundStation());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
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
          setConnection((c) => ({
            ...c,
            serialConnected: msg.serial as boolean,
            serialPort: msg.port ?? c.serialPort,
          }));
        }

        if (msg.type === "logging") {
          loggingRef.current = msg.active as boolean;
          setLogging(msg.active as boolean);
        }

        if (msg.type === "elink_connection") {
          if (msg.connected) lastElinkActivityRef.current = Date.now();
          setConnection((c) => ({
            ...c,
            elinkConnected: msg.connected as boolean,
            elinkReady: (msg.ready ?? msg.connected) as boolean,
            elinkPort: msg.port ?? c.elinkPort,
          }));
        }

        if (msg.type === "link_health") {
          if (msg.elinkFresh) lastElinkActivityRef.current = Date.now();
          setConnection((c) => ({
            ...c,
            elinkConnected: msg.elinkFresh as boolean,
            halowFresh: msg.halowFresh as boolean,
          }));
        }

        if (msg.type === "elink_telemetry" && msg.data) {
          const now = Date.now();
          const next = mergePacket(latestElinkRef.current ?? INITIAL_TELEMETRY,
                                   msg.data as TelemetryData);
          latestElinkRef.current = next;
          lastElinkActivityRef.current = now;
          lastElinkRxRef.current = now;
          setElinkTelemetry(next);
          setTelemetry(next);
          setConnection((c) => ({
            ...c,
            activeSource: "elink",
            elinkConnected: true,
          }));
        }

        if (msg.type === "telemetry" && msg.data) {
          const now = Date.now();
          const next = mergePacket(latestHalowRef.current ?? INITIAL_TELEMETRY,
                                   msg.data as TelemetryData);
          latestHalowRef.current = next;
          lastHalowRxRef.current = now;
          const elinkFresh = (now - lastElinkRxRef.current) <= LINK_FRESHNESS_MS;
          if (!elinkFresh) {
            setTelemetry(next);
            setConnection((c) => ({
              ...c,
              activeSource: "halow",
              halowFresh: true,
            }));
          }
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
  }, []);

  useEffect(() => {
    connectWs();
    return () => {
      wsRef.current?.close();
    };
  }, [connectWs]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const source = selectTelemetrySource(
        now,
        lastElinkRxRef.current,
        lastHalowRxRef.current,
        latestElinkRef.current !== null,
        latestHalowRef.current !== null,
      );
      const elinkTelemetryFresh = source === "elink";
      const elinkActivityFresh = (now - lastElinkActivityRef.current)
        <= LINK_FRESHNESS_MS;
      const halowFresh = latestHalowRef.current !== null
        && (now - lastHalowRxRef.current) <= LINK_FRESHNESS_MS;

      if (elinkTelemetryFresh && latestElinkRef.current) {
        setTelemetry(latestElinkRef.current);
      } else if (halowFresh && latestHalowRef.current) {
        setTelemetry(latestHalowRef.current);
      } else {
        setTelemetry((prev) => prev.receivedAt === null || prev.halowStatus === "INTERRUPTED"
          ? prev
          : { ...prev, halowStatus: "INTERRUPTED" });
      }

      const elinkAlive = lastElinkRxRef.current > 0
        && (now - lastElinkRxRef.current) <= LIVE_TIMEOUT_MS;
      const halowAlive = lastHalowRxRef.current > 0
        && (now - lastHalowRxRef.current) <= LIVE_TIMEOUT_MS;
      const mode: LinkMode = elinkAlive && halowAlive ? "halow+elink"
        : elinkAlive ? "elink"
        : halowAlive ? "halow"
        : "none";

      setConnection((c) => ({
        ...c,
        elinkConnected: elinkActivityFresh,
        halowFresh,
        activeSource: source,
        mode,
      }));
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const sendCommand = useCallback(
    async (cmd: string, params: number[] = []): Promise<CommandResult> => {
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

  const changeElinkPort = useCallback(async (newPort: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${HTTP_URL}/config/elink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: newPort }),
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
    <LiveDataContext.Provider value={{
      telemetry,
      elinkTelemetry,
      connection,
      logging,
      groundStation,
      setGroundStation,
      toggleLogging,
      sendCommand,
      changePort,
      changeElinkPort,
      listPorts,
    }}>
      {children}
    </LiveDataContext.Provider>
  );
}

export function useLiveData(): LiveDataContextValue {
  const ctx = useContext(LiveDataContext);
  if (!ctx) throw new Error("useLiveData must be inside LiveDataProvider");
  return ctx;
}
