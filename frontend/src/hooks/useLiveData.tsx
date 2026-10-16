import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { LINK_FRESHNESS_MS, selectTelemetrySource } from "@/lib/linkSelection";
import { HTTP_URL, WS_URL } from "@/lib/backendUrl";
import { normalizeRoutePoint, type RoutePoint } from "@/lib/route";
import { groundRadio, payloadRadio } from "@/lib/radio";
import {
  gsRfFromSnapshot,
  sampleFromPacket,
  type GsRfView,
  type TelemetrySample,
} from "@/lib/telemetrySeries";
import {
  GROUND_STATION_STORAGE_KEY,
  isGroundStationConfigured,
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
  // RF measured by the payload (of the ground station's frames); null when it reports 0
  rssi: number | null;
  snr: number | null;
  freqDevHz: number | null;
  successRate: number | null;
  noiseFloor: number | null;
  txMcs: number | null;
  halowStatus: "ACTIVE" | "DEGRADED" | "INTERRUPTED" | null;
  // RF measured by the ground station's module (of the payload's frames). Never mixed with the above.
  gsRssi: number | null;
  gsSnr: number | null;
  gsNoiseFloor: number | null;
  gsFreqDev: number | null;
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
  /** Payload-measured RSSI / SNR, one point per packet that carried a reading. */
  rssiHistory: { time: number; rssi: number; snr: number | null }[];
  /** Ground-station-measured RSSI / SNR, in the same time base. */
  gsRssiHistory: { time: number; rssi: number; snr: number | null }[];
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
  /** True while E-Link packets keep arriving (within ELINK_STALE_MS). */
  elinkFresh: boolean;
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
  /** Whichever link is delivering (E-Link first): the map, antenna and top bar use this. */
  telemetry: TelemetryData;
  /** Only what arrived over E-Link; stops updating when E-Link goes quiet. */
  elinkTelemetry: TelemetryData;
  /** Only what arrived over HaLow; stops updating when HaLow goes quiet. */
  halowTelemetry: TelemetryData;
  connection: ConnectionState;
  logging: boolean;
  groundStation: GroundStationLocation;
  setGroundStation: (location: GroundStationLocation) => void;
  /** Every E-Link packet received, flattened for the telemetry charts (newest last). */
  elinkSamples: TelemetrySample[];
  /** Radio dumps of the ground-station HaLow module (RSSI, SNR, noise floor...). */
  gsRfSamples: GsRfView[];
  /** Payload GNSS route recorded by the backend, point by point. */
  route: RoutePoint[];
  clearRoute: () => Promise<boolean>;
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
  gsRssi: null,
  gsSnr: null,
  gsNoiseFloor: null,
  gsFreqDev: null,
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
  gsRssiHistory: [],
  trajectoryHistory: [],
};

/**
 * The payload and the ground station each measure the link on the other's frames. Both
 * sets travel on every packet; each is cleaned on its own (a 0 is no reading) and kept in
 * its own fields. Neither is ever used in place of the other.
 */
function withSeparateRadio(raw: TelemetryData): TelemetryData {
  const gs = raw as TelemetryData & {
    gsRssi?: number | null; gsSnr?: number | null; gsNoiseFloor?: number | null; gsFreqDev?: number | null;
  };
  const payload = payloadRadio({
    rssi: raw.rssi, snr: raw.snr, noiseFloor: raw.noiseFloor, freqDevHz: raw.freqDevHz,
  });
  const ground = groundRadio({
    gsRssi: gs.gsRssi, gsSnr: gs.gsSnr, gsNoiseFloor: gs.gsNoiseFloor, gsFreqDev: gs.gsFreqDev,
  });
  return {
    ...raw,
    rssi: payload.rssi, snr: payload.snr, noiseFloor: payload.noiseFloor, freqDevHz: payload.freqDevHz,
    gsRssi: ground.rssi, gsSnr: ground.snr, gsNoiseFloor: ground.noiseFloor, gsFreqDev: ground.freqDevHz,
  };
}

const MAX_SERIES_POINTS = 5000;

// The route on the map comes from the backend; this short history is only used to spot jumps.
const MAX_TRAJECTORY_POINTS = 5000;

function mergePacket(prev: TelemetryData, d: TelemetryData): TelemetryData {
  const lat = d.latitude;
  const lng = d.longitude;
  const hasPosition = lat !== null && lng !== null;
  const lastPt = prev.trajectoryHistory[prev.trajectoryHistory.length - 1];
  const jump = Boolean(lastPt && hasPosition
    && (Math.abs(lastPt.lat - lat) > 1 || Math.abs(lastPt.lng - lng) > 1));
  const hasPayloadRf = d.rssi !== null && d.timestamp !== null;
  const hasGroundRf = d.gsRssi !== null && d.timestamp !== null;
  return {
    ...d,
    rssiHistory: hasPayloadRf
      ? [...(jump ? [] : prev.rssiHistory), {
          time: d.timestamp / 1000,
          rssi: d.rssi,
          snr: d.snr,
        }].slice(-60)
      : prev.rssiHistory,
    gsRssiHistory: hasGroundRf
      ? [...(jump ? [] : prev.gsRssiHistory), {
          time: d.timestamp / 1000,
          rssi: d.gsRssi,
          snr: d.gsSnr,
        }].slice(-60)
      : prev.gsRssiHistory,
    trajectoryHistory: hasPosition
      ? [...(jump ? [] : prev.trajectoryHistory), {
          lat,
          lng,
          alt: d.altitude ?? 0,
        }].slice(-MAX_TRAJECTORY_POINTS)
      : prev.trajectoryHistory,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

// Longer than the slowest downlink period (HaLow, ~10 s) so the mode does not flap.
// Each link has its own rhythm (E-Link ~5 s, HaLow ~10 s): a source is "quiet" after
// a little over two of its periods, so a page never shows old numbers as live.
const ELINK_STALE_MS = 12_000;
const HALOW_STALE_MS = 25_000;

const MAX_ROUTE_POINTS = 20_000;

export function LiveDataProvider({ children }: { children: React.ReactNode }) {
  const [telemetry, setTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [elinkTelemetry, setElinkTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [halowTelemetry, setHalowTelemetry] = useState<TelemetryData>(INITIAL_TELEMETRY);
  const [logging, setLogging] = useState(false);
  const [route, setRoute] = useState<RoutePoint[]>([]);
  const [elinkSamples, setElinkSamples] = useState<TelemetrySample[]>([]);
  const [gsRfSamples, setGsRfSamples] = useState<GsRfView[]>([]);
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
    elinkFresh: false,
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

  // The backend logs where the ground station is and measures the distance to the payload
  // from it, so it is told on every connection and whenever the operator changes it.
  useEffect(() => {
    if (!connection.wsConnected) return;
    void fetch(`${HTTP_URL}/gs/position`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...groundStation, source: isGroundStationConfigured() ? "operator" : "default" }),
    }).catch(() => {});
  }, [groundStation, connection.wsConnected]);

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

        if (msg.type === "route" && Array.isArray(msg.points)) {
          setRoute((msg.points as RoutePoint[]).slice(-MAX_ROUTE_POINTS).map(normalizeRoutePoint));
        }

        if (msg.type === "route_point" && msg.point) {
          const point = normalizeRoutePoint(msg.point as RoutePoint);
          setRoute((prev) => [...prev, point].slice(-MAX_ROUTE_POINTS));
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
            // halowFresh is judged here against HaLow's own period (the backend's 5 s
            // window is shorter than the 10 s between HaLow packets)
          }));
        }

        if (msg.type === "history") {
          const samples = Array.isArray(msg.elink)
            ? (msg.elink as unknown[]).map((p) => sampleFromPacket(p)).filter((x): x is TelemetrySample => x !== null)
            : [];
          const dumps = Array.isArray(msg.gsRf)
            ? (msg.gsRf as unknown[]).map(gsRfFromSnapshot).filter((x): x is GsRfView => x !== null)
            : [];
          setElinkSamples(samples.slice(-MAX_SERIES_POINTS));
          setGsRfSamples(dumps.slice(-MAX_SERIES_POINTS));
        }

        if (msg.type === "gs_rf" && msg.data) {
          const dump = gsRfFromSnapshot(msg.data);
          if (dump) setGsRfSamples((prev) => [...prev, dump].slice(-MAX_SERIES_POINTS));
        }

        if (msg.type === "elink_telemetry" && msg.data) {
          const now = Date.now();
          const sample = sampleFromPacket(msg.data, now);
          if (sample) setElinkSamples((prev) => [...prev, sample].slice(-MAX_SERIES_POINTS));
          const next = mergePacket(latestElinkRef.current ?? INITIAL_TELEMETRY,
                                   withSeparateRadio(msg.data as TelemetryData));
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
                                   withSeparateRadio(msg.data as TelemetryData));
          latestHalowRef.current = next;
          lastHalowRxRef.current = now;
          setHalowTelemetry(next);
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
        && (now - lastHalowRxRef.current) <= HALOW_STALE_MS;
      const elinkFresh = latestElinkRef.current !== null
        && (now - lastElinkRxRef.current) <= ELINK_STALE_MS;

      if (elinkTelemetryFresh && latestElinkRef.current) {
        setTelemetry(latestElinkRef.current);
      } else if (halowFresh && latestHalowRef.current) {
        setTelemetry(latestHalowRef.current);
      } else {
        setTelemetry((prev) => prev.receivedAt === null || prev.halowStatus === "INTERRUPTED"
          ? prev
          : { ...prev, halowStatus: "INTERRUPTED" });
      }

      // A page that listens to one link goes INTERRUPTED when that link is quiet,
      // keeping the last values on screen (they are not refreshed by the other link).
      const interrupt = (prev: TelemetryData): TelemetryData =>
        prev.receivedAt === null || prev.halowStatus === "INTERRUPTED"
          ? prev
          : { ...prev, halowStatus: "INTERRUPTED" };
      if (!elinkFresh) setElinkTelemetry(interrupt);
      if (!halowFresh) setHalowTelemetry(interrupt);

      const elinkAlive = lastElinkRxRef.current > 0 && elinkFresh;
      const halowAlive = lastHalowRxRef.current > 0 && halowFresh;
      const mode: LinkMode = elinkAlive && halowAlive ? "halow+elink"
        : elinkAlive ? "elink"
        : halowAlive ? "halow"
        : "none";

      setConnection((c) => ({
        ...c,
        elinkConnected: elinkActivityFresh,
        halowFresh,
        elinkFresh,
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

  const clearRoute = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${HTTP_URL}/route/clear`, { method: "POST" });
      return res.ok;
    } catch {
      return false;
    }
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
      halowTelemetry,
      connection,
      logging,
      groundStation,
      setGroundStation,
      route,
      clearRoute,
      elinkSamples,
      gsRfSamples,
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
