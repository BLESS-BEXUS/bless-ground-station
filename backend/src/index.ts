import { SerialPort } from "serialport";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import dgram from "node:dgram";
import {
  parsePacket,
  parsePong,
  buildCommand,
  buildPingCommand,
  CMD,
  PACKET_SIZE,
} from "./protocol";
import type { CmdId } from "./protocol";
import { MissionLogger } from "./logger";

// ─── Config ──────────────────────────────────────────────────────────────────

const WS_PORT = 8765;
let halowPort = process.env.HALOW_PORT ?? "COM3";
let elinkPort = process.env.ELINK_PORT ?? "";
const BAUD_RATE = 115200;
const ETH_HEADER_SIZE = 14;
const ELINK_REMOTE_HOST = process.env.ELINK_REMOTE_HOST ?? "10.86.110.200";
const ELINK_REMOTE_PORT = Number(process.env.ELINK_REMOTE_PORT ?? 5000);
const ELINK_LOCAL_PORT = Number(process.env.ELINK_LOCAL_PORT ?? 5000);
const ELINK_PING_TIMEOUT_MS = Number(process.env.ELINK_PING_TIMEOUT_MS ?? 2000);

// ─── Loggers ──────────────────────────────────────────────────────────────────

const halowLogger = new MissionLogger(
  "./logs", "halow_live.csv",
  "receivedAt,timestamp,packetCount,latitude,longitude,altitude,gpsFix,gpsSats," +
  "rssi,snr,freqDevHz,successRate,noiseFloor,txMcs," +
  "systemState,halowCurrMa,chipTempC,heaterPower," +
  "pressurePa,extTempC,intTempC,extHumidityRh,radiationCps,errorFlags,halowStatus," +
  "gsRssi,gsSnr,gsFreqDev,gsMcs\n",
  true
);
const elinkLogger = new MissionLogger(
  "./logs", "elink_live.csv",
  "receivedAt,timestamp,packetCount,latitude,longitude,altitude,gpsFix,gpsSats," +
  "rssi,snr,freqDevHz,successRate,noiseFloor,txMcs," +
  "systemState,halowCurrMa,chipTempC,heaterPower," +
  "pressurePa,extTempC,intTempC,extHumidityRh,radiationCps,errorFlags,halowStatus\n",
  false
);
halowLogger.open();
elinkLogger.open();

// ─── GS RF stats (from T-HaLow rx0/tx0 ASCII lines) ─────────────────────────

let gsRfStats = { rssi: 0, snr: 0, freqDev: 0, mcs: 0, per: 0, bw: "" };

function parseRx0Line(line: string): void {
  const m1 = line.match(/rssi=(-?\d+)/);
  const m2 = line.match(/freqDev=(\d+)/);
  const m3 = line.match(/mcs=(\d+)/);
  const m4 = line.match(/bw=(\S+)/);
  if (m1) gsRfStats.rssi = parseInt(m1[1]);
  if (m2) gsRfStats.freqDev = parseInt(m2[1]);
  if (m3) gsRfStats.mcs = parseInt(m3[1]);
  if (m4) gsRfStats.bw = m4[1];
}

function parseTx0Line(line: string): void {
  const m1 = line.match(/snr=(\d+)/);
  const m2 = line.match(/per=\s*(\d+)/);
  if (m1) gsRfStats.snr = parseInt(m1[1]);
  if (m2) gsRfStats.per = parseInt(m2[1]);
}

// ─── HaLow serial ─────────────────────────────────────────────────────────────

let halowConnected = false;
let halowSerial: SerialPort | null = null;
let halowRxCount = 0;
let halowBuf = Buffer.alloc(0);
let halowPendingLen = 0;
let halowAutoReconnect = true;

function processHalowData(): void {
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
          halowRxCount++;
          packet.gsRssi = gsRfStats.rssi;
          packet.gsSnr = gsRfStats.snr;
          packet.gsFreqDev = gsRfStats.freqDev;
          packet.gsMcs = gsRfStats.mcs;
          halowLogger.write(packet);
          broadcast({ type: "telemetry", data: packet });
          console.log(`[halow] #${halowRxCount} alt=${packet.altitude}m rssi=${packet.rssi}dBm gsRssi=${gsRfStats.rssi}`);
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

    const rxMatch = line.match(/^\+RXDATA:(\d+)$/);
    if (rxMatch) { halowPendingLen = parseInt(rxMatch[1]); continue; }
    if (line.startsWith("rx0:")) parseRx0Line(line);
    else if (line.startsWith("tx0:")) parseTx0Line(line);
  }
}

function openHalow(): void {
  if (!halowPort) return;
  console.log(`[halow] Opening ${halowPort} at ${BAUD_RATE} baud`);
  halowAutoReconnect = true;
  halowSerial = new SerialPort({ path: halowPort, baudRate: BAUD_RATE });
  halowSerial.on("open", () => {
    halowConnected = true;
    console.log("[halow] Port open");
    broadcast({ type: "connection", serial: true, port: halowPort });
  });
  halowSerial.on("data", (chunk: Buffer) => {
    halowBuf = Buffer.concat([halowBuf, chunk]);
    processHalowData();
  });
  halowSerial.on("error", (err) => {
    console.error("[halow] Error:", err.message);
    halowConnected = false;
    broadcast({ type: "connection", serial: false, error: err.message });
  });
  halowSerial.on("close", () => {
    halowConnected = false;
    console.warn("[halow] Port closed");
    broadcast({ type: "connection", serial: false, port: halowPort });
    if (halowAutoReconnect) setTimeout(openHalow, 5000);
  });
}

function closeHalow(): Promise<void> {
  return new Promise((resolve) => {
    halowAutoReconnect = false;
    halowBuf = Buffer.alloc(0);
    if (halowSerial?.isOpen) halowSerial.close(() => { halowSerial = null; resolve(); });
    else { halowSerial = null; resolve(); }
  });
}

// ─── E-Link serial ────────────────────────────────────────────────────────────

let elinkConnected = false;
let elinkSerial: SerialPort | null = null;
let elinkRxCount = 0;
let elinkBuf = Buffer.alloc(0);
let elinkAutoReconnect = true;

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
  console.log(`[elink] Opening ${elinkPort} at ${BAUD_RATE} baud`);
  elinkAutoReconnect = true;
  elinkSerial = new SerialPort({ path: elinkPort, baudRate: BAUD_RATE });
  elinkSerial.on("open", () => {
    elinkConnected = true;
    console.log("[elink] Port open");
    publishElinkConnection();
  });
  elinkSerial.on("data", (chunk: Buffer) => {
    elinkBuf = Buffer.concat([elinkBuf, chunk]);
    processElinkData();
  });
  elinkSerial.on("error", (err) => {
    console.error("[elink] Error:", err.message);
    elinkConnected = false;
    publishElinkConnection();
  });
  elinkSerial.on("close", () => {
    elinkConnected = false;
    console.warn("[elink] Port closed");
    publishElinkConnection();
    if (elinkAutoReconnect) setTimeout(openElink, 5000);
  });
}

function closeElink(): Promise<void> {
  return new Promise((resolve) => {
    elinkAutoReconnect = false;
    elinkBuf = Buffer.alloc(0);
    if (elinkSerial?.isOpen) elinkSerial.close(() => { elinkSerial = null; resolve(); });
    else { elinkSerial = null; resolve(); }
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

const elinkUdp = dgram.createSocket("udp4");
const pendingPings = new Map<number, PendingPing>();
let elinkUdpReady = false;
let nextPingToken = Math.floor(Math.random() * 0x10000);

function elinkEndpoint(): string {
  return `${ELINK_REMOTE_HOST}:${ELINK_REMOTE_PORT} UDP`;
}

function publishElinkConnection(): void {
  broadcast({
    type: "elink_connection",
    connected: elinkUdpReady || elinkConnected,
    port: elinkUdpReady ? elinkEndpoint() : elinkPort,
  });
}

function handlePong(frame: Buffer, source: string): boolean {
  const pong = parsePong(frame);
  if (!pong) return false;

  const pending = pendingPings.get(pong.token);
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
  elinkLogger.write(packet);
  broadcast({ type: "elink_telemetry", data: packet });
  console.log(`[elink] #${elinkRxCount} alt=${packet.altitude}m rssi=${packet.rssi}dBm`);
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

const httpServer = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
    res.end(); return;
  }

  // Send command through the E-Link UDP network.
  if (req.method === "POST" && req.url?.startsWith("/cmd/")) {
    const cmdName = req.url.slice(5).toUpperCase() as keyof typeof CMD;
    if (!(cmdName in CMD)) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "Unknown command" })); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        if (cmdName === "PING") {
          const result = await sendPing();
          res.writeHead(200, cors);
          res.end(JSON.stringify({ ok: true, cmd: cmdName, ...result }));
          return;
        }

        const params: number[] = body ? (JSON.parse(body).params ?? []) : [];
        const payload = Buffer.from(params);
        const frame = buildCommand(CMD[cmdName] as CmdId, payload);
        await sendElinkFrame(frame);
        console.log(`[cmd] Sent ${cmdName} to ${elinkEndpoint()}`);
        res.writeHead(200, cors);
        res.end(JSON.stringify({ ok: true, cmd: cmdName }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.startsWith("Ping timeout") ? 504 : 503;
        res.writeHead(status, cors);
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    }); return;
  }

  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, cors);
    res.end(JSON.stringify({
      halow: { connected: halowConnected, port: halowPort, packets: halowRxCount },
      elink: {
        connected: elinkUdpReady || elinkConnected,
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
      },
    })); return;
  }

  if (req.method === "POST" && req.url === "/logging/start") {
    halowLogger.start();
    elinkLogger.start();
    broadcast({ type: "logging", active: true });
    res.writeHead(200, cors);
    res.end(JSON.stringify({ ok: true, active: true }));
    return;
  }

  if (req.method === "POST" && req.url === "/logging/stop") {
    halowLogger.stop();
    elinkLogger.stop();
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

  // Configure HaLow port
  if (req.method === "POST" && req.url === "/config") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
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
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
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
  ws.send(JSON.stringify({ type: "connection", serial: halowConnected, port: halowPort }));
  ws.send(JSON.stringify({
    type: "elink_connection",
    connected: elinkUdpReady || elinkConnected,
    port: elinkUdpReady ? elinkEndpoint() : elinkPort,
  }));
  ws.send(JSON.stringify({ type: "logging", active: halowLogger.isActive() }));
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

process.on("SIGINT", () => {
  console.log("\n[info] Shutting down...");
  halowLogger.close();
  elinkLogger.close();
  halowSerial?.close();
  elinkSerial?.close();
  elinkUdp.close();
  process.exit(0);
});
