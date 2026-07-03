import { SerialPort } from "serialport";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import dgram from "dgram";
import { parsePacket, buildCommand, CMD, PACKET_SIZE } from "./protocol";
import type { CmdId } from "./protocol";
import { MissionLogger } from "./logger";

// ─── Config ──────────────────────────────────────────────────────────────────

const WS_PORT = 8765;
let halowPort = process.env.HALOW_PORT ?? "COM3";
const BAUD_RATE = 115200;
const ETH_HEADER_SIZE = 14;

// E-Link is now a real network device (W5500, IP + MAC) — talk to it over UDP, not serial
const ELINK_LOCAL_PORT = Number(process.env.ELINK_LOCAL_PORT ?? 6001);
let elinkRemoteIp = process.env.ELINK_REMOTE_IP ?? "10.86.110.200";
let elinkRemotePort = Number(process.env.ELINK_REMOTE_PORT ?? 5000);

// ─── Loggers ──────────────────────────────────────────────────────────────────

const halowLogger = new MissionLogger(
  "./logs", "halow_live.csv",
  "receivedAt,timestamp,packetCount,latitude,longitude,altitude,gpsFix,gpsFixQuality,gpsSats," +
  "rssi,snr,freqDevHz,successRate,noiseFloor,txMcs," +
  "rfVoltMv,halowCurrMa,chipTempC,heaterPower," +
  "pressurePa,extTempC,intTempC,extHumidityRh,radiationCps,errorFlags,halowStatus," +
  "gsRssi,gsSnr,gsFreqDev,gsMcs\n",
  true
);
const elinkLogger = new MissionLogger(
  "./logs", "elink_live.csv",
  "receivedAt,timestamp,packetCount,latitude,longitude,altitude,gpsFix,gpsFixQuality,gpsSats," +
  "rssi,snr,freqDevHz,successRate,noiseFloor,txMcs," +
  "rfVoltMv,halowCurrMa,chipTempC,heaterPower," +
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

// ─── E-Link UDP (W5500 network module) ─────────────────────────────────────────

let elinkConnected = false;
let elinkSocket: dgram.Socket | null = null;
let elinkRxCount = 0;
let elinkLastSeenIp = "";

function processElinkPacket(msg: Buffer, remoteIp: string): void {
  if (msg.length < PACKET_SIZE) return;

  // Scan for sync marker in case of any framing/padding
  let syncIdx = -1;
  for (let i = 0; i <= msg.length - 2; i++) {
    const w = msg.readUInt16LE(i);
    if (w === 0xb1e5 || w === 0xaa55) { syncIdx = i; break; }
  }
  if (syncIdx === -1 || msg.length - syncIdx < PACKET_SIZE) return;

  const packet = parsePacket(msg.slice(syncIdx, syncIdx + PACKET_SIZE));
  if (!packet) return;

  elinkRxCount++;
  elinkLastSeenIp = remoteIp;
  if (!elinkConnected) {
    elinkConnected = true;
    broadcast({ type: "elink_connection", connected: true, port: `${remoteIp}:${ELINK_LOCAL_PORT}` });
  }
  elinkLogger.write(packet);
  broadcast({ type: "elink_telemetry", data: packet });
  console.log(`[elink] #${elinkRxCount} alt=${packet.altitude}m rssi=${packet.rssi}dBm from ${remoteIp}`);
}

function openElink(): void {
  elinkSocket = dgram.createSocket("udp4");

  elinkSocket.on("listening", () => {
    const addr = elinkSocket!.address();
    console.log(`[elink] UDP socket listening on ${addr.address}:${addr.port} (expecting W5500 at ${elinkRemoteIp}:${elinkRemotePort})`);
  });

  elinkSocket.on("message", (msg, rinfo) => {
    processElinkPacket(msg, rinfo.address);
  });

  elinkSocket.on("error", (err) => {
    console.error("[elink] UDP error:", err.message);
    elinkConnected = false;
    broadcast({ type: "elink_connection", connected: false, error: err.message });
  });

  elinkSocket.bind(ELINK_LOCAL_PORT);
}

function closeElink(): Promise<void> {
  return new Promise((resolve) => {
    if (elinkSocket) elinkSocket.close(() => { elinkSocket = null; resolve(); });
    else resolve();
  });
}

function sendElinkCommand(frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!elinkSocket) { reject(new Error("E-Link UDP socket not open")); return; }
    elinkSocket.send(frame, elinkRemotePort, elinkRemoteIp, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
    res.end(); return;
  }

  // Send command via E-Link UDP (W5500)
  if (req.method === "POST" && req.url?.startsWith("/cmd/")) {
    const cmdName = req.url.slice(5).toUpperCase() as keyof typeof CMD;
    if (!(cmdName in CMD)) { res.writeHead(400, cors); res.end(JSON.stringify({ error: "Unknown command" })); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const params: number[] = body ? (JSON.parse(body).params ?? []) : [];
      const payload = Buffer.from(params);
      const frame = buildCommand(CMD[cmdName] as CmdId, payload);

      try {
        await sendElinkCommand(frame);
        console.log(`[cmd] Sent ${cmdName} via E-Link UDP to ${elinkRemoteIp}:${elinkRemotePort}`);
        res.writeHead(200, cors); res.end(JSON.stringify({ ok: true, cmd: cmdName }));
      } catch (e) {
        res.writeHead(500, cors); res.end(JSON.stringify({ error: String(e) }));
      }
    }); return;
  }

  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, cors);
    res.end(JSON.stringify({
      halow: { connected: halowConnected, port: halowPort, packets: halowRxCount },
      elink: { connected: elinkConnected, remoteIp: elinkRemoteIp, remotePort: elinkRemotePort, localPort: ELINK_LOCAL_PORT, lastSeenIp: elinkLastSeenIp, packets: elinkRxCount },
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

  // Configure E-Link target (W5500 IP + port)
  if (req.method === "POST" && req.url === "/config/elink") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { ip, port } = JSON.parse(body) as { ip?: string; port?: number };
        if (ip) elinkRemoteIp = ip;
        if (port) elinkRemotePort = port;
        console.log(`[config] E-Link target: ${elinkRemoteIp}:${elinkRemotePort}`);
        res.writeHead(200, cors); res.end(JSON.stringify({ ok: true, ip: elinkRemoteIp, port: elinkRemotePort }));
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
  ws.send(JSON.stringify({ type: "elink_connection", connected: elinkConnected, port: elinkConnected ? `${elinkLastSeenIp}:${ELINK_LOCAL_PORT}` : "—" }));
  ws.send(JSON.stringify({ type: "logging", active: halowLogger.isActive() }));
  ws.on("close", () => console.log("[ws] Client disconnected"));
});

httpServer.listen(WS_PORT, () => {
  console.log(`[ws]   WebSocket server listening on ws://localhost:${WS_PORT}`);
  console.log(`[http] REST API on http://localhost:${WS_PORT}`);
  console.log(`[info] HALOW_PORT=${halowPort}  ELINK_UDP=${elinkRemoteIp}:${elinkRemotePort} (local :${ELINK_LOCAL_PORT})`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

openHalow();
openElink();

process.on("SIGINT", () => {
  console.log("\n[info] Shutting down...");
  halowLogger.close();
  elinkLogger.close();
  halowSerial?.close();
  elinkSocket?.close();
  process.exit(0);
});
