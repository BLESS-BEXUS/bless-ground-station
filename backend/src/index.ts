import { SerialPort } from "serialport";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import {
  parsePacket,
  parsePong,
  parseCommandResponse,
  buildCommand,
  buildPingCommand,
  CMD,
  PACKET_SIZE,
} from "./protocol";
import type { BlessPacket, CmdId } from "./protocol";
import { GsRfLogger, MissionEventLogger, MissionLogger } from "./logger";
import { LmacStatusParser } from "./gsLmac";
import type { GsRfSnapshot } from "./gsLmac";
import { GsRadioLive } from "./gsRadio";
import { RouteTracker } from "./track";
import type { RouteLink } from "./track";
import { TileCache, handleTileRequest } from "./tiles";
import {
  AtCommandChannel,
  GROUND_AT_COMMANDS,
  displayValue,
  validateAtCommand,
} from "./halowAt";
import { classifyResponseLine } from "./halowAt";
import type { AtResult, GroundAtCommand } from "./halowAt";

// ─── Config ──────────────────────────────────────────────────────────────────

const WS_PORT = Number(process.env.WS_PORT ?? 8765);
let halowPort = process.env.HALOW_PORT ?? "COM3";
let elinkPort = process.env.ELINK_PORT ?? "";
const BAUD_RATE = 115200;
const ETH_HEADER_SIZE = 14;
const ELINK_REMOTE_HOST = process.env.ELINK_REMOTE_HOST ?? "172.16.18.152";
const ELINK_REMOTE_PORT = Number(process.env.ELINK_REMOTE_PORT ?? 5000);
const ELINK_LOCAL_PORT = Number(process.env.ELINK_LOCAL_PORT ?? 5000);
const ELINK_PING_TIMEOUT_MS = Number(process.env.ELINK_PING_TIMEOUT_MS ?? 2000);
const ELINK_COMMAND_TIMEOUT_MS = Number(process.env.ELINK_COMMAND_TIMEOUT_MS ?? 2000);
const LINK_FRESHNESS_MS = Number(process.env.LINK_FRESHNESS_MS ?? 5000);

// ─── Loggers ──────────────────────────────────────────────────────────────────

const halowLogger = new MissionLogger(
  "./logs", "halow_live.csv",
  "receivedAt,timestamp,packetCount,latitude,longitude,altitude,gpsFix,gpsSats," +
  "rssi,snr,freqDevHz,successRate,noiseFloor,txMcs," +
  "systemState,halowCurrMa,chipTempC,heaterPower," +
  "pressurePa,extTempC,intTempC,extHumidityRh,radiationCps,errorFlags,halowStatus," +
  "gsRssi,gsSnr,gsFreqDev,gsMcs,gsNoiseFloor,gsPer\n",
  true
);
const elinkLogger = new MissionLogger(
  "./logs", "elink_live.csv",
  "receivedAt,timestamp,packetCount,latitude,longitude,altitude,gpsFix,gpsSats," +
  "rssi,snr,freqDevHz,successRate,noiseFloor,txMcs," +
  "systemState,halowCurrMa,chipTempC,heaterPower," +
  "pressurePa,extTempC,intTempC,extHumidityRh,radiationCps,errorFlags,halowStatus," +
  "gsRssi,gsSnr,gsFreqDev,gsMcs,gsNoiseFloor,gsPer\n",
  true
);
const gsRfLogger = new GsRfLogger("./logs", "gs_rf_live.csv");
const missionEventLogger = new MissionEventLogger("./logs", "mission_events.csv");
halowLogger.open();
elinkLogger.open();

// Payload GNSS route (shared by every connected UI, kept across page reloads and restarts)
// HaLow GNSS counts as "being received" for this long after the last HaLow packet
const ROUTE_HALOW_WINDOW_MS = Number(process.env.ROUTE_HALOW_WINDOW_MS ?? 30_000);
const routeTracker = new RouteTracker(path.resolve("./logs/route.ndjson"), ROUTE_HALOW_WINDOW_MS);
routeTracker.load();

// Map tiles are fetched once and then served from disk (works offline afterwards)
const tileCache = new TileCache(path.resolve(process.env.TILE_CACHE_DIR ?? "./tiles"));

function recordRoute(packet: BlessPacket, via: RouteLink): void {
  // The payload reports RSSI 0 now; the ground station's own reading colors the map
  const point = routeTracker.record(packet, via, Date.now(), packet.gsRssi ?? null);
  if (point) broadcast({ type: "route_point", point });
}

function startLogging(): void {
  if (!halowLogger.isActive()) {
    const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
    halowLogger.start(sessionId);
    elinkLogger.start(sessionId);
    gsRfLogger.start(sessionId);
    missionEventLogger.start(sessionId);
  }
  broadcast({ type: "logging", active: true });
}

// Logging starts with the first packet from either link. It happens once per
// run, so a manual stop from the UI is never overridden by the next packet.
let autoLoggingHandled = false;
function autoStartLogging(): void {
  if (autoLoggingHandled) return;
  autoLoggingHandled = true;
  startLogging();
}

// ─── Ground-station radio figures (from the T-HaLow module's own output) ─────
// The payload sends RSSI / SNR / noise floor / frequency deviation as 0, so these
// come from what the ground module measures on the frames it receives: the
// periodic "LMAC STATUS" dump and the "rx0:" / "tx0:" lines.

const GS_STATS_FRESH_MS = Number(process.env.GS_STATS_FRESH_MS ?? 60_000);
const gsRadio = new GsRadioLive(GS_STATS_FRESH_MS);
const lmacParser = new LmacStatusParser();
/** Recent serial lines that are neither the LMAC dump nor an AT reply: shows what else the module prints. */
const RECENT_OTHER_LINES = 40;
const recentOtherLines: { t: number; line: string }[] = [];
let rx0LinesSeen = 0;

// What the web pages get on connect, so charts survive a page reload
const HISTORY_LIMIT = Number(process.env.TELEMETRY_HISTORY_LIMIT ?? 4000);
const elinkHistory: BlessPacket[] = [];
const gsRfHistory: GsRfSnapshot[] = [];
let lmacBlock: string[] = [];
let lastLmacBlock: string[] = [];

function remember<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
}

function onGsRfSnapshot(snapshot: GsRfSnapshot): void {
  gsRadio.fromSnapshot(snapshot);
  remember(gsRfHistory, snapshot);
  gsRfLogger.write(snapshot);
  lastLmacBlock = lmacBlock;
  lmacBlock = [];
  broadcast({ type: "gs_rf", data: snapshot });
}

// ─── HaLow serial ─────────────────────────────────────────────────────────────

let halowConnected = false;
let halowSerial: SerialPort | null = null;
let halowRxCount = 0;
let halowBuf = Buffer.alloc(0);
let halowPendingLen = 0;
let halowPendingSince = 0;
let halowAutoReconnect = true;
let lastHalowPacketAt = 0;

// AT commands for the ground-station T-HaLow (same interface the payload uses on its own)
const groundAt = new AtCommandChannel((data) => {
  if (!halowSerial?.isOpen) throw new Error("HaLow serial port is not open");
  halowSerial.write(data);
});
const groundAtHistory: AtResult[] = [];
const groundAtApplied: Partial<Record<GroundAtCommand, { value: string; at: string }>> = {};
const GROUND_AT_HISTORY_LIMIT = 100;

async function runGroundAtCommand(name: GroundAtCommand, value: string): Promise<AtResult> {
  const result = await groundAt.send(name, value);
  groundAtHistory.push(result);
  if (groundAtHistory.length > GROUND_AT_HISTORY_LIMIT) groundAtHistory.shift();
  if (result.ok) groundAtApplied[name] = { value: result.value, at: result.finishedAt };
  missionEventLogger.writeGroundRadioConfig({
    status: result.ok ? "OK" : "FAILED",
    setting: `${name}=${displayValue(name, value)}`,
    sentUtc: result.sentAt,
    finishedUtc: result.finishedAt,
  });
  console.log(`[halow-at] AT+${name}=${result.value} -> ${result.ok ? "OK" : `FAILED (${result.error})`}`);
  return result;
}

// Largest frame the module can announce (Ethernet MTU + header), and how long a
// half-received frame may wait before it is given up on.
const MAX_HALOW_FRAME_BYTES = 1600;
const HALOW_FRAME_TIMEOUT_MS = 2000;

function processHalowData(): void {
  // A frame that never completes (module reset mid-frame) must not swallow what follows
  if (halowPendingLen > 0 && Date.now() - halowPendingSince > HALOW_FRAME_TIMEOUT_MS) {
    console.warn(`[halow] Dropping incomplete ${halowPendingLen}-byte frame`);
    halowPendingLen = 0;
  }

  while (halowBuf.length > 0) {
    if (halowPendingLen > 0) {
      if (halowBuf.length < halowPendingLen) return;
      const rawFrame = halowBuf.slice(0, halowPendingLen);
      halowBuf = halowBuf.slice(halowPendingLen);
      // skip trailing \r\n
      if (halowBuf.length >= 2 && halowBuf[0] === 0x0d && halowBuf[1] === 0x0a) halowBuf = halowBuf.slice(2);
      else if (halowBuf.length >= 1 && halowBuf[0] === 0x0a) halowBuf = halowBuf.slice(1);
      halowPendingLen = 0;

      if (rawFrame.length > ETH_HEADER_SIZE) {
        const payload = rawFrame.slice(ETH_HEADER_SIZE);
        const packet = parsePacket(payload);
        if (packet) {
          lastHalowPacketAt = Date.now();
          halowRxCount++;
          gsRadio.attach(packet);
          autoStartLogging();
          halowLogger.write(packet);
          recordRoute(packet, "halow");
          broadcast({ type: "telemetry", data: packet });
          console.log(`[halow] #${halowRxCount} alt=${packet.altitude}m rssi=${packet.rssi}dBm gsRssi=${packet.gsRssi ?? "-"}`);
        } else {
          console.warn(`[halow] Parse failed (${payload.length}B), sync=0x${payload.length >= 2 ? payload.readUInt16LE(0).toString(16) : "??"}`);
        }
      }
      continue;
    }

    const nlIdx = halowBuf.indexOf(0x0a);
    if (nlIdx === -1) {
      if (halowBuf.length > 200) halowBuf = Buffer.alloc(0);
      return;
    }

    const line = halowBuf.slice(0, nlIdx).toString("utf-8").replace(/\r$/, "").trim();
    halowBuf = halowBuf.slice(nlIdx + 1);
    if (!line) continue;

    // Not anchored at the start: noise from a cut frame may precede the announcement
    const rxMatch = line.match(/\+RXDATA:(\d+)$/);
    if (rxMatch) {
      const announced = parseInt(rxMatch[1], 10);
      if (announced > 0 && announced <= MAX_HALOW_FRAME_BYTES) {
        halowPendingLen = announced;
        halowPendingSince = Date.now();
      } else {
        console.warn(`[halow] Ignoring implausible frame length +RXDATA:${rxMatch[1]}`);
      }
      continue;
    }
    // The module's periodic radio dump. An OK / ERROR line in the middle of it still
    // belongs to a pending AT command, so those are left for the command channel.
    const startsDump = /^LMAC STATUS/i.test(line);
    if ((lmacParser.isReading() || startsDump) && classifyResponseLine(line) === "other") {
      if (startsDump) lmacBlock = [];
      lmacBlock.push(line);
      const snapshot = lmacParser.feed(line);
      if (snapshot) onGsRfSnapshot(snapshot);
      continue;
    }
    if (groundAt.handleLine(line)) continue;
    if (gsRadio.fromRx0Line(line)) { rx0LinesSeen++; continue; }
    if (!gsRadio.fromTx0Line(line)) {
      recentOtherLines.push({ t: Date.now(), line: line.slice(0, 200) });
      if (recentOtherLines.length > RECENT_OTHER_LINES) recentOtherLines.shift();
    }
  }
}

function halowDisabled(port: string): boolean {
  return ["", "none", "off", "disabled"].includes(port.trim().toLowerCase());
}

const HALOW_RECONNECT_MS = 3000;
let halowReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let halowLastError = "";

function clearHalowReconnect(): void {
  if (halowReconnectTimer) {
    clearTimeout(halowReconnectTimer);
    halowReconnectTimer = null;
  }
}

/**
 * Retry opening the port. Only one retry can be pending, so a manual reconnect and
 * the automatic one never race, and it keeps trying while the cable is out.
 */
function scheduleHalowReconnect(): void {
  if (!halowAutoReconnect || halowReconnectTimer || halowDisabled(halowPort)) return;
  halowReconnectTimer = setTimeout(() => {
    halowReconnectTimer = null;
    openHalow();
  }, HALOW_RECONNECT_MS);
}

function openHalow(): void {
  if (halowDisabled(halowPort)) {
    console.log("[halow] Disabled (HALOW_PORT=none): E-Link-only ground station");
    halowConnected = false;
    broadcast({ type: "connection", serial: false, port: halowPort, disabled: true });
    return;
  }
  clearHalowReconnect();
  if (halowSerial?.isOpen) return;   // already open: nothing to do

  if (!halowLastError) console.log(`[halow] Opening ${halowPort} at ${BAUD_RATE} baud`);
  halowAutoReconnect = true;
  const port = new SerialPort({ path: halowPort, baudRate: BAUD_RATE });
  halowSerial = port;

  port.on("open", () => {
    if (halowSerial !== port) {   // replaced while it was opening: do not keep the handle
      port.close();
      return;
    }
    halowLastError = "";
    halowConnected = true;
    halowBuf = Buffer.alloc(0);   // never continue a frame cut by the unplug
    halowPendingLen = 0;
    console.log("[halow] Port open");
    broadcast({ type: "connection", serial: true, port: halowPort });
  });
  port.on("data", (chunk: Buffer) => {
    if (halowSerial !== port) return;
    halowBuf = Buffer.concat([halowBuf, chunk]);
    processHalowData();
  });
  port.on("error", (err) => {
    if (halowSerial !== port) return;
    halowConnected = false;
    // Say it once per outage, not on every retry
    if (err.message !== halowLastError) {
      console.error("[halow] Error:", err.message, `(retrying every ${HALOW_RECONNECT_MS / 1000} s)`);
    }
    halowLastError = err.message;
    broadcast({ type: "connection", serial: false, port: halowPort, error: err.message });
    if (!port.isOpen) scheduleHalowReconnect();   // could not open: cable out or port busy
  });
  port.on("close", () => {
    if (halowSerial !== port) return;
    halowConnected = false;
    groundAt.abortAll("HaLow serial port closed");
    console.warn("[halow] Port closed");
    broadcast({ type: "connection", serial: false, port: halowPort });
    scheduleHalowReconnect();
  });
}

function closeHalow(): Promise<void> {
  return new Promise((resolve) => {
    halowAutoReconnect = false;
    clearHalowReconnect();
    halowLastError = "";
    halowBuf = Buffer.alloc(0);
    halowPendingLen = 0;
    const port = halowSerial;
    halowSerial = null;
    halowConnected = false;
    if (port?.isOpen) port.close(() => resolve());
    else resolve();
  });
}

// ─── E-Link serial ────────────────────────────────────────────────────────────

let elinkConnected = false;
let elinkSerial: SerialPort | null = null;
let elinkRxCount = 0;
let elinkBuf = Buffer.alloc(0);
let elinkAutoReconnect = true;
let elinkReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleElinkReconnect(): void {
  if (!elinkAutoReconnect || elinkReconnectTimer || !elinkPort) return;
  elinkReconnectTimer = setTimeout(() => {
    elinkReconnectTimer = null;
    openElink();
  }, 5000);
}

function processElinkData(): void {
  while (elinkBuf.length >= PACKET_SIZE) {
    // Scan for sync markers 0xB1E5 (LE: 0xE5 0xB1) or 0xAA55 (LE: 0x55 0xAA)
    let syncIdx = -1;
    for (let i = 0; i <= elinkBuf.length - 2; i++) {
      const w = elinkBuf.readUInt16LE(i);
      if (w === 0xb1e5 || w === 0xaa55) { syncIdx = i; break; }
    }
    if (syncIdx === -1) { elinkBuf = elinkBuf.slice(elinkBuf.length - 1); return; }
    if (syncIdx > 0) elinkBuf = elinkBuf.slice(syncIdx);
    if (elinkBuf.length < PACKET_SIZE) return;

    const candidate = elinkBuf.slice(0, PACKET_SIZE);
    if (handleElinkTelemetry(candidate)) {
      elinkBuf = elinkBuf.slice(PACKET_SIZE);
    } else {
      elinkBuf = elinkBuf.slice(2);
    }
  }
}

function openElink(): void {
  if (!elinkPort) return;
  if (elinkReconnectTimer) { clearTimeout(elinkReconnectTimer); elinkReconnectTimer = null; }
  if (elinkSerial?.isOpen) return;
  console.log(`[elink] Opening ${elinkPort} at ${BAUD_RATE} baud`);
  elinkAutoReconnect = true;
  const port = new SerialPort({ path: elinkPort, baudRate: BAUD_RATE });
  elinkSerial = port;
  port.on("open", () => {
    if (elinkSerial !== port) { port.close(); return; }
    elinkConnected = true;
    console.log("[elink] Port open");
    publishElinkConnection();
  });
  port.on("data", (chunk: Buffer) => {
    if (elinkSerial !== port) return;
    elinkBuf = Buffer.concat([elinkBuf, chunk]);
    processElinkData();
  });
  port.on("error", (err) => {
    if (elinkSerial !== port) return;
    console.error("[elink] Error:", err.message);
    elinkConnected = false;
    publishElinkConnection();
    if (!port.isOpen) scheduleElinkReconnect();   // could not open: retry like the HaLow port
  });
  port.on("close", () => {
    if (elinkSerial !== port) return;
    elinkConnected = false;
    console.warn("[elink] Port closed");
    publishElinkConnection();
    scheduleElinkReconnect();
  });
}

function closeElink(): Promise<void> {
  return new Promise((resolve) => {
    elinkAutoReconnect = false;
    if (elinkReconnectTimer) { clearTimeout(elinkReconnectTimer); elinkReconnectTimer = null; }
    elinkBuf = Buffer.alloc(0);
    const port = elinkSerial;
    elinkSerial = null;
    elinkConnected = false;
    if (port?.isOpen) port.close(() => resolve());
    else resolve();
  });
}

// ─── E-Link UDP ───────────────────────────────────────────────────────────────

interface PingResult {
  token: number;
  rttMs: number;
  from: string;
}

interface PendingPing {
  sentAt: number;
  timeout: NodeJS.Timeout;
  resolve: (result: PingResult) => void;
  reject: (error: Error) => void;
}

interface MissionTimeSyncResult {
  t0UtcApprox: string;
  commandSentUtc: string;
  confirmedUtc: string;
  from: string;
}

interface PendingMissionTimeSync {
  commandSentUtc: string;
  timeout: NodeJS.Timeout;
  resolve: (result: MissionTimeSyncResult) => void;
  reject: (error: Error) => void;
}

const elinkUdp = dgram.createSocket("udp4");
const pendingPings = new Map<number, PendingPing>();
let pendingMissionTimeSync: PendingMissionTimeSync | null = null;
let elinkUdpReady = false;
let nextPingToken = Math.floor(Math.random() * 0x10000);
let lastElinkActivityAt = 0;

function elinkPayloadAlive(): boolean {
  return (Date.now() - lastElinkActivityAt) <= LINK_FRESHNESS_MS;
}

function elinkEndpoint(): string {
  return `${ELINK_REMOTE_HOST}:${ELINK_REMOTE_PORT} UDP`;
}

function publishElinkConnection(): void {
  broadcast({
    type: "elink_connection",
    ready: elinkUdpReady || elinkConnected,
    connected: elinkConnected || (elinkUdpReady && elinkPayloadAlive()),
    port: elinkUdpReady ? elinkEndpoint() : elinkPort,
  });
}

function handlePong(frame: Buffer, source: string): boolean {
  const pong = parsePong(frame);
  if (!pong) return false;

  const pending = pendingPings.get(pong.token);
  lastElinkActivityAt = Date.now();
  if (!pending) {
    console.warn(`[ping] Unexpected/stale PONG token=0x${pong.token.toString(16).padStart(4, "0")} from ${source}`);
    return true;
  }

  clearTimeout(pending.timeout);
  pendingPings.delete(pong.token);
  const result: PingResult = {
    token: pong.token,
    rttMs: Date.now() - pending.sentAt,
    from: source,
  };
  console.log(`[ping] PONG token=0x${pong.token.toString(16).padStart(4, "0")} rtt=${result.rttMs}ms from ${source}`);
  broadcast({ type: "ping_result", ok: true, ...result });
  pending.resolve(result);
  return true;
}

function handleElinkTelemetry(frame: Buffer): boolean {
  const packet = parsePacket(frame);
  if (!packet) return false;

  elinkRxCount++;
  lastElinkActivityAt = Date.now();
  gsRadio.attach(packet);
  remember(elinkHistory, packet);
  autoStartLogging();
  elinkLogger.write(packet);
  recordRoute(packet, "elink");
  broadcast({ type: "elink_telemetry", data: packet });
  console.log(`[elink] #${elinkRxCount} alt=${packet.altitude}m rssi=${packet.rssi}dBm`);
  return true;
}

function handleCommandResponse(frame: Buffer, source: string): boolean {
  const response = parseCommandResponse(frame);
  if (!response) return false;

  lastElinkActivityAt = Date.now();
  if (!pendingMissionTimeSync) {
    console.log(`[cmd] ${response.message} from ${source}`);
    return true;
  }

  if (response.kind === "ack" && response.message !== "ACK: SYNC_TIME") {
    console.log(`[cmd] Ignoring unrelated ACK while SYNC_TIME is pending: ${response.message}`);
    return true;
  }

  const pending = pendingMissionTimeSync;
  pendingMissionTimeSync = null;
  clearTimeout(pending.timeout);

  if (response.kind === "nack") {
    pending.reject(new Error(`SYNC_TIME rejected by payload: ${response.message}`));
    return true;
  }

  const confirmedUtc = new Date().toISOString();
  const result: MissionTimeSyncResult = {
    /* Normal E-Link latency is accepted, so the PC send instant is the
     * approximate UTC anchor corresponding to payload mission T+0. */
    t0UtcApprox: pending.commandSentUtc,
    commandSentUtc: pending.commandSentUtc,
    confirmedUtc,
    from: source,
  };
  missionEventLogger.writeMissionTimeSync({
    commandId: CMD.SYNC_TIME,
    missionTimeMs: 0,
    t0UtcApprox: result.t0UtcApprox,
    commandSentUtc: result.commandSentUtc,
    confirmedUtc: result.confirmedUtc,
    source,
  });
  broadcast({ type: "mission_time_sync", ok: true, ...result });
  console.log(`[mission-time] T+0 confirmed; UTC≈${result.t0UtcApprox}`);
  pending.resolve(result);
  return true;
}

function sendElinkFrame(frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!elinkUdpReady) {
      reject(new Error("E-Link UDP socket is not ready"));
      return;
    }
    elinkUdp.send(frame, ELINK_REMOTE_PORT, ELINK_REMOTE_HOST, (error) => {
      if (error) reject(error);
      else {
        console.log(`[elink-udp] TX ${frame.length}B to ${elinkEndpoint()}`);
        resolve();
      }
    });
  });
}

function sendPing(): Promise<PingResult> {
  const token = nextPingToken;
  nextPingToken = (nextPingToken + 1) & 0xffff;
  const frame = buildPingCommand(token);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPings.delete(token);
      const error = new Error(`Ping timeout after ${ELINK_PING_TIMEOUT_MS} ms`);
      broadcast({ type: "ping_result", ok: false, token, error: error.message });
      reject(error);
    }, ELINK_PING_TIMEOUT_MS);

    pendingPings.set(token, { sentAt: Date.now(), timeout, resolve, reject });
    sendElinkFrame(frame).catch((error: Error) => {
      clearTimeout(timeout);
      pendingPings.delete(token);
      reject(error);
    });
  });
}

function sendMissionTimeSync(): Promise<MissionTimeSyncResult> {
  if (pendingMissionTimeSync) {
    return Promise.reject(new Error("A SYNC_TIME command is already pending"));
  }

  const commandSentUtc = new Date().toISOString();
  const frame = buildCommand(CMD.SYNC_TIME);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingMissionTimeSync = null;
      reject(new Error(`SYNC_TIME timeout after ${ELINK_COMMAND_TIMEOUT_MS} ms`));
    }, ELINK_COMMAND_TIMEOUT_MS);

    pendingMissionTimeSync = { commandSentUtc, timeout, resolve, reject };
    sendElinkFrame(frame).catch((error: Error) => {
      clearTimeout(timeout);
      pendingMissionTimeSync = null;
      reject(error);
    });
  });
}

function openElinkUdp(): void {
  elinkUdp.on("listening", () => {
    elinkUdpReady = true;
    const local = elinkUdp.address();
    console.log(`[elink-udp] Listening on ${local.address}:${local.port}; payload=${elinkEndpoint()}`);
    publishElinkConnection();
  });

  elinkUdp.on("message", (frame, remote) => {
    const source = `${remote.address}:${remote.port}`;
    if (handlePong(frame, source)) return;
    if (frame.length >= PACKET_SIZE && handleElinkTelemetry(frame)) return;
    if (handleCommandResponse(frame, source)) return;
    console.warn(`[elink-udp] Ignored ${frame.length}B datagram from ${source}`);
  });

  elinkUdp.on("error", (error) => {
    elinkUdpReady = false;
    console.error("[elink-udp] Error:", error.message);
    publishElinkConnection();
  });

  elinkUdp.on("close", () => {
    elinkUdpReady = false;
    publishElinkConnection();
  });

  elinkUdp.bind(ELINK_LOCAL_PORT);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 64 * 1024;

class BadRequestError extends Error {}

/** Reads a small request body; answers 413 and discards anything larger. */
function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  onBody: (body: string) => void | Promise<void>,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (chunk: Buffer) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      res.writeHead(413, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
        Connection: "close",
      });
      res.end(JSON.stringify({ ok: false, error: "Request body too large" }));
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (tooLarge) return;
    Promise.resolve(onBody(Buffer.concat(chunks).toString("utf-8"))).catch((error: unknown) => {
      if (res.headersSent) return;
      res.writeHead(500, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
  });
}

/** `{ "params": [a, b] }` -> up to two bytes, as the payload command frame carries. */
function parseCommandParams(body: string): number[] {
  if (!body.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
  const params = (parsed as { params?: unknown } | null)?.params ?? [];
  if (
    !Array.isArray(params) || params.length > 2
    || params.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  ) {
    throw new BadRequestError("params must be up to 2 whole numbers between 0 and 255");
  }
  return params as number[];
}

const httpServer = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
    res.end(); return;
  }

  // Map tiles: served from the local disk cache, downloaded once when missing.
  if (req.url?.startsWith("/tiles/")) {
    if (req.method !== "GET") {
      res.writeHead(405, { "Access-Control-Allow-Origin": "*", Allow: "GET" });
      res.end();
      return;
    }
    void handleTileRequest(req, res, tileCache);
    return;
  }

  // Ground-station HaLow module: current state and what was applied this session
  if (req.method === "GET" && req.url === "/halow/config") {
    res.writeHead(200, cors);
    res.end(JSON.stringify({
      connected: halowConnected,
      disabled: halowDisabled(halowPort),
      port: halowPort,
      commands: GROUND_AT_COMMANDS,
      applied: groundAtApplied,
      history: groundAtHistory,
    }));
    return;
  }

  // Run one AT command on the ground-station HaLow module
  if (req.method === "POST" && req.url === "/halow/config") {
    readBody(req, res, async (body) => {
      try {
        const { name, value } = JSON.parse(body || "{}") as { name?: string; value?: string | number };
        const checked = validateAtCommand(String(name ?? ""), String(value ?? ""));
        if (!checked.ok) {
          res.writeHead(400, cors); res.end(JSON.stringify({ ok: false, error: checked.error })); return;
        }
        if (halowDisabled(halowPort) || !halowConnected) {
          res.writeHead(503, cors);
          res.end(JSON.stringify({
            ok: false,
            error: halowDisabled(halowPort)
              ? "This ground station has no HaLow module (HALOW_PORT=none)"
              : `HaLow serial port ${halowPort} is not open`,
          }));
          return;
        }
        const result = await runGroundAtCommand(name as GroundAtCommand, checked.value);
        res.writeHead(200, cors);
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, cors);
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/route") {
    res.writeHead(200, cors);
    res.end(JSON.stringify(routeTracker.list()));
    return;
  }

  if (req.method === "POST" && req.url === "/route/clear") {
    routeTracker.clear();
    broadcast({ type: "route", points: [] });
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Send command through the E-Link UDP network.
  if (req.method === "POST" && req.url?.startsWith("/cmd/")) {
    const cmdName = req.url.slice(5).toUpperCase() as keyof typeof CMD;
    if (!(cmdName in CMD)) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "Unknown command" })); return; }
    readBody(req, res, async (body) => {
      try {
        if (cmdName === "PING") {
          const result = await sendPing();
          res.writeHead(200, cors);
          res.end(JSON.stringify({ ok: true, cmd: cmdName, ...result }));
          return;
        }

        if (cmdName === "SYNC_TIME") {
          const result = await sendMissionTimeSync();
          res.writeHead(200, cors);
          res.end(JSON.stringify({ ok: true, cmd: cmdName, ...result }));
          return;
        }

        if (pendingMissionTimeSync) {
          throw new Error("SYNC_TIME confirmation pending; wait before sending another command");
        }

        const params = parseCommandParams(body);
        if (cmdName === "SET_HALOW_MODE" && (params.length !== 1 || params[0] > 1)) {
          throw new BadRequestError("SET_HALOW_MODE needs one parameter: 0 = AP, 1 = GROUP");
        }
        const payload = Buffer.from(params);
        const frame = buildCommand(CMD[cmdName] as CmdId, payload);
        await sendElinkFrame(frame);
        console.log(`[cmd] Sent ${cmdName} to ${elinkEndpoint()}`);
        res.writeHead(200, cors);
        res.end(JSON.stringify({ ok: true, cmd: cmdName }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof BadRequestError ? 400
          : message.includes("timeout after") ? 504 : 503;
        res.writeHead(status, cors);
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    }); return;
  }

  // The latest parsed radio snapshot and the raw dump it came from
  if (req.method === "GET" && req.url === "/gs/rf") {
    res.writeHead(200, cors);
    res.end(JSON.stringify({
      latest: gsRfHistory[gsRfHistory.length - 1] ?? null,
      rawBlock: lastLmacBlock,
      otherLines: recentOtherLines,
      rx0LinesSeen,
      snapshots: gsRfHistory.length,
      live: {
        rssi: gsRadio.get("rssi"),
        snr: gsRadio.get("snr"),
        noiseFloor: gsRadio.noiseFloor(),
        freqDev: gsRadio.get("freqDev"),
        mcs: gsRadio.get("mcs"),
        per: gsRadio.get("per"),
      },
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, cors);
    res.end(JSON.stringify({
      halow: { connected: halowConnected, port: halowPort, packets: halowRxCount },
      elink: {
        ready: elinkUdpReady || elinkConnected,
        connected: elinkConnected || (elinkUdpReady && elinkPayloadAlive()),
        endpoint: elinkEndpoint(),
        localUdpPort: ELINK_LOCAL_PORT,
        serialPort: elinkPort,
        packets: elinkRxCount,
      },
      logging: {
        active: halowLogger.isActive(),
        halowFile: halowLogger.getFilePath(),
        elinkFile: elinkLogger.getFilePath(),
        halowRows: halowLogger.getRowCount(),
        elinkRows: elinkLogger.getRowCount(),
        missionEventFile: missionEventLogger.getFilePath(),
        missionEventRows: missionEventLogger.getRowCount(),
      },
    })); return;
  }

  if (req.method === "POST" && req.url === "/logging/start") {
    autoLoggingHandled = true;
    startLogging();
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true, active: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/logging/stop") {
    autoLoggingHandled = true;
    halowLogger.stop();
    elinkLogger.stop();
    gsRfLogger.stop();
    broadcast({ type: "logging", active: false, halowRows: halowLogger.getRowCount(), elinkRows: elinkLogger.getRowCount() });
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true, active: false }));
    return;
  }

  if (req.method === "GET" && req.url === "/ports") {
    SerialPort.list().then((ports) => {
      res.writeHead(200, cors);
      res.end(JSON.stringify(ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer ?? "" }))));
    }).catch((err) => { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); });
    return;
  }

  if (req.method === "GET" && req.url === "/logs") {
    const logDir = path.resolve("./logs");
    const files = fs.existsSync(logDir)
      ? fs.readdirSync(logDir).filter((name) => name.endsWith(".csv"))
      : [];
    res.writeHead(200, cors);
    res.end(JSON.stringify(files));
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/logs/")) {
    let requested: string;
    try {
      requested = path.basename(decodeURIComponent(req.url.slice(6)));
    } catch {
      res.writeHead(400, cors); res.end(JSON.stringify({ error: "Malformed log file name" })); return;
    }
    const filePath = path.resolve("./logs", requested);
    const logRoot = path.resolve("./logs") + path.sep;
    if (!filePath.startsWith(logRoot) || !fs.existsSync(filePath)) {
      res.writeHead(404, cors); res.end(JSON.stringify({ error: "Log not found" })); return;
    }
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${requested}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Configure HaLow port
  if (req.method === "POST" && req.url === "/config") {
    readBody(req, res, async (body) => {
      try {
        const { port: newPort } = JSON.parse(body) as { port?: string };
        if (!newPort) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "port required" })); return; }
        console.log(`[config] HaLow port: ${halowPort} → ${newPort}`);
        await closeHalow();
        halowPort = newPort;
        openHalow();
        res.writeHead(200, cors); res.end(JSON.stringify({ ok: true, port: halowPort }));
      } catch (e) { res.writeHead(400, cors); res.end(JSON.stringify({ error: String(e) })); }
    }); return;
  }

  // Configure E-Link port
  if (req.method === "POST" && req.url === "/config/elink") {
    readBody(req, res, async (body) => {
      try {
        const { port: newPort } = JSON.parse(body) as { port?: string };
        if (!newPort) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "port required" })); return; }
        console.log(`[config] E-Link port: ${elinkPort} → ${newPort}`);
        await closeElink();
        elinkPort = newPort;
        openElink();
        res.writeHead(200, cors); res.end(JSON.stringify({ ok: true, port: elinkPort }));
      } catch (e) { res.writeHead(400, cors); res.end(JSON.stringify({ error: String(e) })); }
    }); return;
  }

  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server: httpServer });

function broadcast(msg: object): void {
  const json = JSON.stringify(msg);
  wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(json); });
}

wss.on("connection", (ws) => {
  console.log("[ws] Client connected");
  ws.send(JSON.stringify({
    type: "connection",
    serial: halowConnected,
    port: halowPort,
    disabled: halowDisabled(halowPort),
  }));
  ws.send(JSON.stringify({
    type: "elink_connection",
    ready: elinkUdpReady || elinkConnected,
    connected: elinkConnected || (elinkUdpReady && elinkPayloadAlive()),
    port: elinkUdpReady ? elinkEndpoint() : elinkPort,
  }));
  ws.send(JSON.stringify({ type: "logging", active: halowLogger.isActive() }));
  ws.send(JSON.stringify({ type: "route", points: routeTracker.list() }));
  ws.send(JSON.stringify({ type: "history", elink: elinkHistory, gsRf: gsRfHistory }));
  ws.on("close", () => console.log("[ws] Client disconnected"));
});

httpServer.listen(WS_PORT, () => {
  console.log(`[ws]   WebSocket server listening on ws://localhost:${WS_PORT}`);
  console.log(`[http] REST API on http://localhost:${WS_PORT}`);
  console.log(`[info] HALOW_PORT=${halowPort}  ELINK_UDP=${elinkEndpoint()}`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

openHalow();
openElink();
openElinkUdp();

setInterval(() => {
  publishElinkConnection();
  broadcast({
    type: "link_health",
    elinkFresh: elinkPayloadAlive(),
    halowFresh: (Date.now() - lastHalowPacketAt) <= LINK_FRESHNESS_MS,
  });
}, 1000);

process.on("SIGINT", () => {
  console.log("\n[info] Shutting down...");
  halowLogger.close();
  elinkLogger.close();
  halowSerial?.close();
  elinkSerial?.close();
  elinkUdp.close();
  process.exit(0);
});
