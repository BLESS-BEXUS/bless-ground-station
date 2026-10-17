/**
 * End-to-end tests: the real backend (src/index.ts) is started as a child process
 * with a fake T-HaLow serial module (test-support/fakeSerialport.js) and a fake
 * payload on UDP, then driven through its HTTP, WebSocket and UDP interfaces.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const BACKEND_DIR = path.resolve(__dirname, "..");

// ─── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(40);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}`);
}

function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function freeUdpPort(): Promise<number> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.bind(0, () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

function crc16(buf: Buffer, length: number): number {
  let crc = 0xffff;
  for (let i = 0; i < length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

function telemetryPacket(o: { count: number; lat: number; lng: number; alt?: number; rssi?: number }): Buffer {
  const b = Buffer.alloc(53);
  b.writeUInt16LE(0xb1e5, 0);
  b.writeUInt32LE(o.count * 1000, 2);
  b.writeUInt32LE(o.count, 6);
  b.writeInt32LE(Math.round(o.lat * 1e7), 10);
  b.writeInt32LE(Math.round(o.lng * 1e7), 14);
  b.writeUInt16LE(o.alt ?? 1000, 18);
  b.writeUInt8(0x4c, 20);
  b.writeInt16LE(o.rssi ?? -70, 21);
  b.writeInt8(20, 23);
  b.writeUInt8(100, 26);
  b.writeUInt16LE(2, 30);
  b.writeUInt16LE(173, 32);
  b.writeUInt32LE(97100, 38);
  b.writeUInt16LE(crc16(b, 51), 51);
  return b;
}

function commandChecksum(frame: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 8; i++) sum = (sum + frame[i]) & 0xffff;
  return sum;
}

function pongFrame(token: number): Buffer {
  const b = Buffer.alloc(10);
  b.writeUInt16LE(0xe175, 0);
  b.writeUInt16LE(0xc245, 2);
  b.writeUInt8(0x84, 4);
  b.writeUInt8(2, 5);
  b.writeUInt16LE(token, 6);
  b.writeUInt16LE(commandChecksum(b), 8);
  return b;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  ms: number;
  json: <T = any>() => T; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function request(
  port: number, method: string, urlPath: string, body?: string | object, timeoutMs = 8000,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath, headers: payload ? { "Content-Type": "application/json" } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: buffer,
            ms: Date.now() - started,
            json: () => JSON.parse(buffer.toString("utf-8")),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response to ${method} ${urlPath} within ${timeoutMs} ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class Feed {
  readonly messages: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  private readonly socket: WebSocket;

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket.on("message", (data) => this.messages.push(JSON.parse(data.toString())));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
  }

  ofType(type: string) { return this.messages.filter((m) => m.type === type); }
  close() { this.socket.close(); }
}

interface Backend {
  child: ChildProcess;
  httpPort: number;
  udpPort: number;
  payloadPort: number;
  workDir: string;
  controlDir: string;
  output: () => string;
  alive: () => boolean;
  stop: () => Promise<void>;
}

async function startBackend(
  workDir: string, controlDir: string, extraEnv: Record<string, string> = {},
): Promise<Backend> {
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(controlDir, { recursive: true });
  const httpPort = await freeTcpPort();
  const udpPort = await freeUdpPort();
  const payloadPort = await freeUdpPort();

  let output = "";
  const child = spawn(
    process.execPath,
    [
      "-r", path.join(BACKEND_DIR, "test-support", "fakeSerialport.js"),
      "-r", require.resolve("ts-node/register/transpile-only"),
      path.join(BACKEND_DIR, "src", "index.ts"),
    ],
    {
      cwd: workDir,
      env: {
        ...process.env,
        TS_NODE_PROJECT: path.join(BACKEND_DIR, "tsconfig.json"),
        FAKE_SERIAL_DIR: controlDir,
        FAKE_FRAME_MS: "100",
        WS_PORT: String(httpPort),
        ELINK_LOCAL_PORT: String(udpPort),
        ELINK_REMOTE_HOST: "127.0.0.1",
        ELINK_REMOTE_PORT: String(payloadPort),
        ELINK_PING_TIMEOUT_MS: "600",
        ELINK_COMMAND_TIMEOUT_MS: "600",
        HALOW_PORT: "FAKE",
        TILE_UPSTREAM: "off",
        ROUTE_HALOW_WINDOW_MS: "1500",
        ...extraEnv,
      },
    },
  );
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
  child.stderr?.on("data", (c: Buffer) => { output += c.toString(); });

  let exited = false;
  child.on("exit", () => { exited = true; });

  await until(() => output.includes("REST API on") || exited, 30_000, "backend to start");
  if (exited) throw new Error(`Backend exited while starting:\n${output}`);

  return {
    child, httpPort, udpPort, payloadPort, workDir, controlDir,
    output: () => output,
    alive: () => !exited,
    stop: () => new Promise((resolve) => {
      if (exited) return resolve();
      child.once("exit", () => resolve());
      child.kill();
    }),
  };
}

/** A pretend payload on UDP: answers PING and SYNC_TIME, records what it receives. */
function startPayloadSimulator(port: number) {
  const socket = dgram.createSocket("udp4");
  const received: Buffer[] = [];
  const state = { muted: false };
  socket.on("message", (frame, remote) => {
    received.push(frame);
    if (state.muted || frame.length !== 10) return;
    const id = frame[4];
    if (id === 0x04) socket.send(pongFrame(frame.readUInt16LE(6)), remote.port, remote.address);
    else if (id === 0x05) socket.send(Buffer.from("ACK: SYNC_TIME"), remote.port, remote.address);
  });
  socket.bind(port, "127.0.0.1");
  return { socket, received, state, close: () => new Promise<void>((r) => socket.close(() => r())) };
}

function sendUdp(port: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.send(data, port, "127.0.0.1", (error) => {
      socket.close();
      if (error) reject(error); else resolve();
    });
  });
}

/** Log files whose name starts with `prefix`: at the top of logs/ and inside the mission folders. */
function logFiles(workDir: string, prefix: string): string[] {
  const root = path.join(workDir, "logs");
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix)) out.push(path.join(root, entry.name));
    if (entry.isDirectory() && entry.name.startsWith("mission_")) {
      for (const inner of fs.readdirSync(path.join(root, entry.name))) {
        if (inner.startsWith(prefix)) out.push(path.join(root, entry.name, inner));
      }
    }
  }
  return out.sort();
}

const setFlag = (dir: string, name: string, content = "") => fs.writeFileSync(path.join(dir, name), content);
const clearFlag = (dir: string, name: string) => fs.rmSync(path.join(dir, name), { force: true });
const injectHex = (dir: string, hex: string) => fs.writeFileSync(path.join(dir, `inject-${Date.now()}-${Math.random()}.hex`), hex);
const asHex = (text: string) => Buffer.from(text, "latin1").toString("hex");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

// ─── main scenarios ───────────────────────────────────────────────────────────

describe("ground station backend — normal operation", () => {
  let root: string;
  let backend: Backend;
  let payload: ReturnType<typeof startPayloadSimulator>;
  let feed: Feed;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bless-e2e-"));
    backend = await startBackend(path.join(root, "work"), path.join(root, "control"));
    payload = startPayloadSimulator(backend.payloadPort);
    feed = new Feed(backend.httpPort);
    await feed.opened();
  });

  after(async () => {
    feed?.close();
    await payload?.close();
    await backend?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = (p: string) => request(backend.httpPort, "GET", p);
  const post = (p: string, body?: string | object) => request(backend.httpPort, "POST", p, body);
  const halowPackets = async () => (await get("/status")).json().halow.packets as number;

  it("starts with the HaLow module connected and nothing received", async () => {
    await until(async () => (await get("/status")).json().halow.connected === true, 5000, "HaLow connected");
    const status = (await get("/status")).json();
    assert.equal(status.halow.packets, 0);
    assert.equal(status.elink.packets, 0);
    assert.equal(status.logging.active, false);
  });

  it("greets a new WebSocket client with the connection, logging and route state", async () => {
    await until(() => feed.ofType("route").length > 0, 3000, "route greeting");
    const types = new Set(feed.messages.map((m) => m.type));
    for (const t of ["connection", "elink_connection", "logging", "route"]) assert.ok(types.has(t), `missing ${t}`);
    assert.deepEqual(feed.ofType("route")[0].points, []);
  });

  it("runs ground HaLow AT commands: OK, ERROR, silence, and invalid input", async () => {
    const ok = (await post("/halow/config", { name: "TXPOWER", value: "12" })).json();
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.response, ["TXPOWER=12", "OK"]);

    const error = (await post("/halow/config", { name: "TXPOWER", value: "19" })).json();
    assert.equal(error.ok, false);
    assert.match(error.error, /ERROR/);

    const silent = (await post("/halow/config", { name: "TX_MCS", value: "5" })).json();
    assert.equal(silent.ok, false);
    assert.equal(silent.attempts, 3);

    assert.equal((await post("/halow/config", { name: "TXPOWER", value: "99" })).status, 400);
    assert.equal((await post("/halow/config", { name: "REBOOT", value: "1" })).status, 400);

    const written = fs.readFileSync(path.join(backend.controlDir, "received.log"), "utf-8");
    assert.ok(written.includes("AT+TXPOWER=12\r\n"));
    assert.equal(written.split("AT+TX_MCS=5\r\n").length - 1, 3, "silent command is sent 3 times");
  });

  it("never exposes the PSK, not even when the module echoes it", async () => {
    const result = (await post("/halow/config", { name: "PSK", value: "supersecretpassword1" })).json();
    assert.equal(result.ok, true);
    const everything = JSON.stringify([result, (await get("/halow/config")).json()]);
    assert.equal(everything.includes("supersecretpassword1"), false);
    for (const file of logFiles(backend.workDir, "")) {
      assert.equal(fs.readFileSync(file, "utf-8").includes("supersecretpassword1"), false);
    }
  });

  it("receives HaLow telemetry, builds the route and starts logging by itself", async () => {
    setFlag(backend.controlDir, "frames", JSON.stringify({ rssi: -72 }));
    await until(() => feed.ofType("telemetry").length >= 3, 5000, "HaLow telemetry on the WebSocket");

    const sample = feed.ofType("telemetry")[0].data;
    assert.equal(sample.rssi, -72);
    assert.ok(Math.abs(sample.latitude - 67.889) < 0.01);
    assert.equal(sample.gsRssi, -72, "ground-station RSSI comes from the rx0: line");

    const route = (await get("/route")).json();
    assert.ok(route.length >= 3);
    assert.ok(route.every((p: any) => p.link === "halow")); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(route[0].rssi, -72);
    assert.ok(feed.ofType("route_point").length >= 3, "points are pushed live to open pages");

    const status = (await get("/status")).json();
    assert.equal(status.logging.active, true, "REC starts with the first packet");
    assert.ok(status.logging.halowRows >= 1);
    const csv = logFiles(backend.workDir, "halow_live_");
    assert.ok(csv.length >= 1);
    assert.match(csv[0], /mission_[^/\\]+[/\\]halow_live_/, "the session's files go in a mission folder");

    // Changes made to the ground module before REC are not queued as events: the mission's
    // configuration lists what had been applied (with the time) when it started
    const events = logFiles(backend.workDir, "mission_events_").map((f) => fs.readFileSync(f, "utf-8")).join("\n");
    assert.equal(/GROUND_HALOW_CONFIG/.test(events), false, "nothing set before REC is replayed into the mission");
    const configFile = logFiles(backend.workDir, "mission_config_")[0];
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert.equal(config.groundStation.radio.appliedFromSoftware.TXPOWER.value, "12");
    assert.equal(config.groundStation.radio.txPower.dBm, 12);
    assert.equal(JSON.stringify(config).includes("supersecretpassword1"), false);
    assert.equal(events.includes("supersecretpassword1"), false);
    clearFlag(backend.controlDir, "frames");
  });

  it("keeps receiving packets while a command waits three seconds for a silent module", async () => {
    setFlag(backend.controlDir, "frames");
    await until(async () => (await halowPackets()) > 0, 3000, "frames flowing");
    const before = await halowPackets();
    const started = Date.now();
    const result = (await post("/halow/config", { name: "TX_MCS", value: "5" })).json();
    const seconds = (Date.now() - started) / 1000;
    const after = await halowPackets();
    clearFlag(backend.controlDir, "frames");

    assert.equal(result.ok, false);
    assert.ok(seconds > 2.5, `command should have waited ~3 s, took ${seconds}`);
    const expected = Math.floor(seconds * 10);             // one frame every 100 ms
    assert.ok(after - before >= expected * 0.7, `packets during the wait: ${after - before}, expected ~${expected}`);
  });

  it("answers E-Link telemetry and turns the route yellow only when HaLow is gone", async () => {
    const routeLength = async () => (await get("/route")).json().length as number;
    const lastLink = async () => { const r = (await get("/route")).json(); return r[r.length - 1].link; };

    // HaLow arriving: the route is blue even for E-Link points
    setFlag(backend.controlDir, "frames");
    await until(async () => (await halowPackets()) > 0, 3000, "frames flowing");
    await sleep(300);
    const beforeElink = await routeLength();
    await sendUdp(backend.udpPort, telemetryPacket({ count: 500, lat: 67.95, lng: 21.2, rssi: -80 }));
    await until(async () => (await routeLength()) > beforeElink, 3000, "E-Link point while HaLow is on");
    assert.equal(feed.ofType("elink_telemetry").length >= 1, true);
    assert.equal(await lastLink(), "halow");

    // HaLow stops; after the window only E-Link feeds the route: yellow
    clearFlag(backend.controlDir, "frames");
    await sleep(2200);
    const beforeYellow = await routeLength();
    await sendUdp(backend.udpPort, telemetryPacket({ count: 501, lat: 67.96, lng: 21.21, rssi: -82 }));
    await until(async () => (await routeLength()) > beforeYellow, 3000, "E-Link point without HaLow");
    assert.equal(await lastLink(), "elink");

    // HaLow comes back: blue again
    setFlag(backend.controlDir, "frames");
    await until(async () => (await lastLink()) === "halow", 4000, "route blue again");
    clearFlag(backend.controlDir, "frames");
  });

  it("serves commands to the payload over E-Link and times out when it is silent", async () => {
    const ping = (await post("/cmd/PING")).json();
    assert.equal(ping.ok, true);
    assert.equal(typeof ping.token, "number");
    assert.ok(ping.rttMs >= 0 && ping.rttMs < 1000);

    const sync = (await post("/cmd/SYNC_TIME")).json();
    assert.equal(sync.ok, true);
    assert.ok(sync.t0UtcApprox);

    const before = payload.received.length;
    const power = (await post("/cmd/SET_TX_POWER", { params: [12] })).json();
    assert.equal(power.ok, true);
    await until(() => payload.received.length > before, 2000, "payload to receive SET_TX_POWER");
    const frame = payload.received[payload.received.length - 1];
    assert.equal(frame[4], 0x21);
    assert.equal(frame[6], 12);

    const modeBefore = payload.received.length;
    assert.equal((await post("/cmd/SET_HALOW_MODE", { params: [1] })).json().ok, true);
    await until(() => payload.received.length > modeBefore, 2000, "payload to receive SET_HALOW_MODE");
    const modeFrame = payload.received[payload.received.length - 1];
    assert.equal(modeFrame[4], 0x24);
    assert.equal(modeFrame[5], 1);
    assert.equal(modeFrame[6], 1);
    assert.equal((await post("/cmd/SET_HALOW_MODE", { params: [2] })).status, 400);
    assert.equal((await post("/cmd/SET_HALOW_MODE")).status, 400);

    payload.state.muted = true;
    const timeout = await post("/cmd/PING");
    assert.equal(timeout.status, 504);
    payload.state.muted = false;
  });

  it("serves cached map tiles instantly, and fails fast for missing ones", async () => {
    const tileDir = path.join(backend.workDir, "tiles", "5", "17");
    fs.mkdirSync(tileDir, { recursive: true });
    fs.writeFileSync(path.join(tileDir, "9.png"), PNG);

    const hit = await get("/tiles/5/17/9.png");
    assert.equal(hit.status, 200);
    assert.equal(hit.headers["content-type"], "image/png");
    assert.deepEqual(hit.body, PNG);

    const miss = await get("/tiles/5/17/10.png");
    assert.equal(miss.status, 404);
    assert.ok(miss.ms < 1000, `uncached tile took ${miss.ms} ms`);

    assert.equal((await get("/tiles/25/0/0.png")).status, 400);
    assert.equal((await get("/tiles/5/99/9.png")).status, 400);
    assert.equal((await get("/tiles/../logs/x.png")).status, 400);
  });

  it("answers non-GET requests on the tile path instead of hanging", async () => {
    const reply = await request(backend.httpPort, "POST", "/tiles/5/17/9.png", "{}", 3000);
    assert.equal(reply.status, 405);
  });

  it("respects a manual logging stop until it is started again", async () => {
    setFlag(backend.controlDir, "frames");
    await until(async () => (await get("/status")).json().logging.active === true, 3000, "logging on");
    await post("/logging/stop");
    const stoppedRows = (await get("/status")).json().logging.halowRows;
    await sleep(700);
    const later = (await get("/status")).json();
    assert.equal(later.logging.active, false);
    assert.equal(later.logging.halowRows, stoppedRows, "no rows written while stopped");

    const filesBefore = logFiles(backend.workDir, "halow_live_").length;
    await sleep(1100);                                   // timestamped session names need a new second
    await post("/logging/start");
    await until(async () => (await get("/status")).json().logging.halowRows > 0, 3000, "rows in the new session");
    const filesAfter = logFiles(backend.workDir, "halow_live_").length;
    assert.equal(filesAfter, filesBefore + 1);
    clearFlag(backend.controlDir, "frames");
  });

  it("recovers by itself when the HaLow module is unplugged and plugged back", async () => {
    setFlag(backend.controlDir, "unplugged");
    await until(async () => (await get("/status")).json().halow.connected === false, 3000, "disconnect detected");

    const refused = await post("/halow/config", { name: "TXPOWER", value: "10" });
    assert.equal(refused.status, 503);

    await sleep(4000);                                   // several failed reconnection attempts
    assert.equal((await get("/status")).json().halow.connected, false);

    clearFlag(backend.controlDir, "unplugged");
    await until(async () => (await get("/status")).json().halow.connected === true, 8000, "automatic reconnection");

    const again = (await post("/halow/config", { name: "TXPOWER", value: "10" })).json();
    assert.equal(again.ok, true);

    setFlag(backend.controlDir, "frames");
    const before = await halowPackets();
    await until(async () => (await halowPackets()) > before + 2, 4000, "telemetry after reconnection");
    clearFlag(backend.controlDir, "frames");

    const logLines = backend.output().split("\n").filter((l) => l.includes("File not found"));
    assert.ok(logLines.length <= 2, `outage error should be logged once, got ${logLines.length}`);
  });

  it("a manual reconnect never fights the automatic one for the port", async () => {
    setFlag(backend.controlDir, "unplugged");
    await until(async () => (await get("/status")).json().halow.connected === false, 3000, "disconnect");
    clearFlag(backend.controlDir, "unplugged");
    const reply = await post("/config", { port: "FAKE" });
    assert.equal(reply.status, 200);
    await until(async () => (await get("/status")).json().halow.connected === true, 5000, "connected");
    await sleep(3500);                                   // the old automatic timer would have fired by now
    assert.equal((await get("/status")).json().halow.connected, true);
    assert.equal(backend.output().includes("Access denied"), false);
  });

  it("stays responsive and consistent under a stress of 1500 packets from both links", async () => {
    // Real traffic is one packet every 5 s; this is ~500 per second on E-Link plus HaLow frames.
    await post("/route/clear");
    const logsDir = path.join(backend.workDir, "logs");
    const before = (await get("/status")).json();

    setFlag(backend.controlDir, "frames");
    const latencies: number[] = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        latencies.push((await get("/status")).ms);
        await sleep(40);
      }
    })();

    const socket = dgram.createSocket("udp4");
    for (let i = 0; i < 1500; i++) {
      socket.send(telemetryPacket({
        count: 10_000 + i, lat: 67.9 + i * 1e-5, lng: 21.1 + i * 1e-5, alt: 1000 + i, rssi: -60 - (i % 40),
      }), backend.udpPort, "127.0.0.1");
      if (i % 5 === 4) await sleep(10);               // ~500 packets per second
    }
    socket.close();
    await sleep(800);
    polling = false;
    await poll;
    clearFlag(backend.controlDir, "frames");
    await sleep(300);

    const status = (await get("/status")).json();
    const received = status.elink.packets - before.elink.packets;
    assert.ok(received >= 1200, `only ${received} of 1500 UDP packets were received`);
    assert.ok(Math.max(...latencies) < 1000, `API stalled for ${Math.max(...latencies)} ms during the stress`);

    // everything that was counted was also logged, and nothing was recorded twice
    const elinkRows = logFiles(backend.workDir, "elink_live_")
      .map((f) => fs.readFileSync(f, "utf-8").trim().split("\n").length - 1)
      .reduce((a, b) => a + b, 0);
    assert.ok(elinkRows >= received, `CSV has ${elinkRows} rows for ${received} packets`);

    const route = (await get("/route")).json();
    assert.ok(route.length <= 20_000);
    const persisted = fs.readFileSync(path.join(logsDir, "route.ndjson"), "utf-8").trim().split("\n").length;
    assert.equal(persisted, route.length, "route file and memory agree");
  });

  it("clears the route on request and tells every open page", async () => {
    const before = feed.ofType("route").length;
    assert.ok((await get("/route")).json().length > 0);
    assert.equal((await post("/route/clear")).status, 200);
    assert.deepEqual((await get("/route")).json(), []);
    await until(() => feed.ofType("route").length > before, 2000, "route broadcast");
    const last = feed.ofType("route").at(-1);
    assert.deepEqual(last.points, []);
  });
});

// ─── hostile input ────────────────────────────────────────────────────────────

describe("ground station backend — hostile and broken input", () => {
  let root: string;
  let backend: Backend;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bless-e2e-bad-"));
    backend = await startBackend(path.join(root, "work"), path.join(root, "control"));
  });

  after(async () => {
    await backend?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = (p: string) => request(backend.httpPort, "GET", p);
  const post = (p: string, body?: string | object) => request(backend.httpPort, "POST", p, body);
  const halowPackets = async () => (await get("/status")).json().halow.packets as number;

  it("survives garbage, bogus lengths, truncated and corrupt frames, and still parses the next good one", async () => {
    await until(async () => (await get("/status")).json().halow.connected === true, 5000, "connected");
    const dir = backend.controlDir;

    // 1) random binary noise with no newline
    injectHex(dir, "ff00aa55".repeat(120));
    // 2) an announced length that would stall the parser forever
    injectHex(dir, asHex("\r\n+RXDATA:4000000000\r\n"));
    await sleep(300);
    // 3) a frame cut short (module reset mid-frame)
    injectHex(dir, asHex("+RXDATA:67\r\n") + "00".repeat(20));
    await sleep(2500);
    // 4) a full frame with a corrupted CRC
    const bad = Buffer.concat([Buffer.alloc(14), telemetryPacket({ count: 7, lat: 67.9, lng: 21.1 })]);
    bad[40] ^= 0xff;
    injectHex(dir, asHex("+RXDATA:67\r\n") + bad.toString("hex") + "0d0a");
    await sleep(300);
    assert.equal(await halowPackets(), 0, "nothing corrupt may become telemetry");
    assert.equal(backend.alive(), true);

    // After all that, normal frames must flow again
    setFlag(dir, "frames");
    await until(async () => (await halowPackets()) >= 3, 6000, "telemetry after the broken input");
    clearFlag(dir, "frames");
  });

  it("answers malformed JSON with 400 on every endpoint that takes a body", async () => {
    for (const p of ["/halow/config", "/config", "/config/elink", "/cmd/SET_TX_POWER"]) {
      const reply = await post(p, "{this is not json");
      assert.equal(reply.status, 400, `${p} -> ${reply.status}`);
    }
  });

  it("rejects out-of-range or non-numeric E-Link command parameters", async () => {
    assert.equal((await post("/cmd/SET_TX_POWER", { params: "abc" })).status, 400);
    assert.equal((await post("/cmd/SET_TX_POWER", { params: [300] })).status, 400);
    assert.equal((await post("/cmd/SET_TX_POWER", { params: [-1] })).status, 400);
    assert.equal((await post("/cmd/SET_TX_POWER", { params: [1.5] })).status, 400);
    assert.equal((await post("/cmd/NOT_A_COMMAND")).status, 400);
  });

  it("does not crash on a malformed percent-escape in a log URL", async () => {
    const reply = await get("/logs/%E0%A4%A");
    assert.equal(reply.status, 400);
    assert.equal(backend.alive(), true, "the server process died");
    assert.equal((await get("/status")).status, 200);
  });

  it("refuses a huge request body without running out of memory", async () => {
    const huge = "x".repeat(400_000);
    const reply = await post("/halow/config", huge);
    assert.equal(reply.status, 413);
    assert.equal((await get("/status")).status, 200);
  });

  it("rejects unknown paths and does not serve files outside logs", async () => {
    assert.equal((await get("/nope")).status, 404);
    assert.equal((await get("/logs/..%2F..%2Fpackage.json")).status, 404);
    assert.equal((await get("/logs/missing.csv")).status, 404);
  });

  it("answers CORS preflight", async () => {
    const reply = await request(backend.httpPort, "OPTIONS", "/halow/config");
    assert.equal(reply.status, 204);
    assert.equal(reply.headers["access-control-allow-origin"], "*");
  });

  it("handles many simultaneous requests and WebSocket clients", async () => {
    const replies = await Promise.all(Array.from({ length: 60 }, () => get("/status")));
    assert.ok(replies.every((r) => r.status === 200));

    const feeds = Array.from({ length: 25 }, () => new Feed(backend.httpPort));
    await Promise.all(feeds.map((f) => f.opened()));
    await sleep(200);
    assert.ok(feeds.every((f) => f.ofType("route").length === 1));
    feeds.forEach((f) => f.close());
    await sleep(200);
    assert.equal((await get("/status")).status, 200);
  });
});

// ─── persistence across a restart ─────────────────────────────────────────────

describe("ground station backend — restart", () => {
  it("starts every run with an empty map, and the route stays in its mission folder", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bless-e2e-restart-"));
    const work = path.join(root, "work");
    const control = path.join(root, "control");
    let backend: Backend | null = null;
    try {
      backend = await startBackend(work, control);
      for (let i = 0; i < 3; i++) {
        await sendUdp(backend.udpPort, telemetryPacket({ count: i, lat: 67.9 + i * 0.01, lng: 21.1, rssi: -60 - i * 5 }));
        await sleep(120);
      }
      await until(async () => (await request(backend!.httpPort, "GET", "/route")).json().length === 3, 4000, "3 route points");
      await backend.stop();

      // the first run's route is in its own mission folder
      const [journal] = logFiles(work, "route_").filter((f) => f.endsWith(".ndjson") && /mission_/.test(f));
      const missionPoints = () => fs.readFileSync(journal, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(missionPoints().map((p: any) => p.rssi), [-60, -65, -70]); // eslint-disable-line @typescript-eslint/no-explicit-any

      // a new run: the map is empty, even though the previous route was never cleared
      backend = await startBackend(work, control);
      assert.deepEqual((await request(backend.httpPort, "GET", "/route")).json(), []);

      // it builds a fresh route, and the old mission's route is left alone
      await sendUdp(backend.udpPort, telemetryPacket({ count: 50, lat: 67.95, lng: 21.2, rssi: -80 }));
      await until(async () => (await request(backend!.httpPort, "GET", "/route")).json().length === 1, 4000, "a fresh point");
      assert.equal(missionPoints().length, 3, "the finished mission's route is not touched");
    } finally {
      await backend?.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── ground-station radio figures ─────────────────────────────────────────────

describe("ground station backend — radio figures from the ground HaLow module", () => {
  let root: string;
  let backend: Backend;
  let feed: Feed;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bless-e2e-rf-"));
    backend = await startBackend(path.join(root, "work"), path.join(root, "control"), {
      GS_STATS_FRESH_MS: "2500",
    });
    feed = new Feed(backend.httpPort);
    await feed.opened();
  });

  after(async () => {
    feed?.close();
    await backend?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = (p: string) => request(backend.httpPort, "GET", p);
  const post = (p: string, body?: string | object) => request(backend.httpPort, "POST", p, body);
  const lmac = (options: object) => setFlag(backend.controlDir, "lmac", JSON.stringify({ everyMs: 150, ...options }));
  const lastSnapshot = () => feed.ofType("gs_rf").at(-1)?.data;
  const lastPoint = async () => {
    const route = (await get("/route")).json();
    return route[route.length - 1];
  };

  it("reads the module's LMAC STATUS dump and publishes RSSI, SNR and noise floor", async () => {
    await until(async () => (await get("/status")).json().halow.connected === true, 5000, "connected");
    lmac({ rssi: -67, snr: 31, rxFrames: 12, chipTempC: 36 });
    await until(() => feed.ofType("gs_rf").length >= 2, 5000, "radio snapshots");

    const snapshot = lastSnapshot();
    assert.equal(snapshot.rssi, -67);
    assert.equal(snapshot.snr, 31);
    assert.equal(snapshot.noiseFloor, -98);            // rssi - snr
    assert.equal(snapshot.rxFrames, 12);
    assert.equal(snapshot.chipTempC, 36);
    assert.equal(snapshot.freqMHz, 866);
    assert.equal(snapshot.stations, 0);
  });

  it("exposes the raw dump and the live figures, to check the mapping against the real module", async () => {
    const reply = (await get("/gs/rf")).json();
    assert.equal(reply.live.rssi, -67);
    assert.equal(reply.live.snr, 31);
    assert.equal(reply.live.noiseFloor, -98);
    assert.ok(reply.rawBlock[0].startsWith("LMAC STATUS"));
    assert.ok(reply.rawBlock.some((l: string) => l.startsWith("dbg:") && l.includes("rssi=-67")));
    assert.ok(reply.snapshots >= 2);
  });

  it("gives E-Link packets the ground station's figures when the payload sends zeros", async () => {
    // the payload reports RSSI 0, as it does now
    await sendUdp(backend.udpPort, telemetryPacket({ count: 1, lat: 67.9, lng: 21.1, alt: 1500, rssi: 0 }));
    await until(() => feed.ofType("elink_telemetry").length >= 1, 3000, "E-Link telemetry");

    const data = feed.ofType("elink_telemetry")[0].data;
    assert.equal(data.rssi, 0, "the payload's own value is left as it came");
    assert.equal(data.gsRssi, -67);
    assert.equal(data.gsSnr, 31);
    assert.equal(data.gsNoiseFloor, -98);
  });

  it("colors the route with the ground station's RSSI when the payload sends 0", async () => {
    await until(async () => (await lastPoint())?.rssi === -67, 3000, "route point with the ground RSSI");
    const point = await lastPoint();
    assert.equal(point.link, "elink");
    assert.equal(point.rssi, -67);
  });

  it("writes the ground figures next to each E-Link row and keeps a CSV of the radio dumps", async () => {
    await sendUdp(backend.udpPort, telemetryPacket({ count: 2, lat: 67.901, lng: 21.101, alt: 1510, rssi: 0 }));
    await until(async () => (await get("/status")).json().logging.elinkRows >= 2, 3000, "rows logged");

    const elinkCsv = logFiles(backend.workDir, "elink_live_");
    const content = fs.readFileSync(elinkCsv[0], "utf-8");
    const [header, firstRow] = content.split("\n");
    assert.match(header, /gsRssi,gsSnr,gsFreqDev,gsMcs,gsNoiseFloor,gsPer/);
    const columns = header.split(",");
    const cells = firstRow.split(",");
    assert.equal(cells[columns.indexOf("gsRssi")], "-67");
    assert.equal(cells[columns.indexOf("gsNoiseFloor")], "-98");

    const rfCsv = logFiles(backend.workDir, "gs_rf_live_");
    assert.equal(rfCsv.length, 1);
    const rfFile = rfCsv[0];
    const rowsInFile = () => fs.readFileSync(rfFile, "utf-8").trim().split(String.fromCharCode(10));
    // a dump arrives every 150 ms, so give the first one after logging started time to come
    await until(() => rowsInFile().length >= 2, 3000, "a radio dump logged while logging is on");
    assert.match(rowsInFile()[0], /rssi,snr,noiseFloor/);
  });

  it("hands a page that just opened the history, so the charts are not empty after a reload", async () => {
    const late = new Feed(backend.httpPort);
    await late.opened();
    await until(() => late.ofType("history").length === 1, 3000, "history message");
    const history = late.ofType("history")[0];
    assert.ok(history.elink.length >= 2);
    assert.ok(history.gsRf.length >= 2);
    assert.equal(history.elink[0].packetCount, 1);
    late.close();
  });

  it("an idle module (rssi=0, nothing received) gives snapshots without RSSI", async () => {
    lmac({});                                          // idle dump: rssi=0, rx cnt=0
    await until(() => lastSnapshot()?.rssi === null, 4000, "idle snapshot");
    assert.equal(lastSnapshot().snr, null);
    assert.equal(lastSnapshot().noiseFloor, null);
  });

  it("does not keep presenting an old reading as current", async () => {
    await sleep(3000);                                 // longer than GS_STATS_FRESH_MS
    await sendUdp(backend.udpPort, telemetryPacket({ count: 3, lat: 67.902, lng: 21.102, alt: 1520, rssi: 0 }));
    await until(() => feed.ofType("elink_telemetry").length >= 3, 3000, "third packet");
    const data = feed.ofType("elink_telemetry").at(-1).data;
    assert.equal(data.gsRssi, undefined);
    assert.equal(data.gsSnr, undefined);
    await until(async () => (await lastPoint())?.pkt === 3, 3000, "third route point");
    assert.equal((await lastPoint()).rssi, null);
  });

  it("an AT command completes while the module prints its dump, without the dump leaking into it", async () => {
    lmac({ rssi: -70, snr: 28, everyMs: 40 });         // a dump every 40 ms: they interleave
    await sleep(200);
    const result = (await post("/halow/config", { name: "TXPOWER", value: "12" })).json();
    assert.equal(result.ok, true);
    assert.deepEqual(result.response, ["TXPOWER=12", "OK"]);
  });
});

describe("ground station backend — where the ground station is", () => {
  let root: string;
  let backend: Backend;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bless-e2e-pos-"));
    backend = await startBackend(path.join(root, "work"), path.join(root, "control"));
  });

  after(async () => {
    await backend?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = (p: string) => request(backend.httpPort, "GET", p);
  const post = (p: string, body?: string | object) => request(backend.httpPort, "POST", p, body);
  const newestRows = (prefix: string): { columns: string[]; rows: string[][] } => {
    const files = logFiles(backend.workDir, prefix);
    const lines = fs.readFileSync(files[files.length - 1], "utf-8").trim().split("\n");
    return { columns: lines[0].split(","), rows: lines.slice(1).map((l) => l.split(",")) };
  };
  const positionEvents = () =>
    newestRows("mission_events_").rows.filter((r) => r[0] === "GROUND_STATION_POSITION");
  const elinkRows = async () => (await get("/status")).json().logging.elinkRows as number;
  const packetAt = (count: number) =>
    sendUdp(backend.udpPort, telemetryPacket({ count, lat: 67.8908, lng: 21.0803, alt: 343 }));

  // same sphere the Map tab uses
  function expected(gs: { lat: number; lng: number; alt: number }, lat: number, lng: number, alt: number) {
    const rad = (d: number) => (d * Math.PI) / 180;
    const a = Math.sin(rad(lat - gs.lat) / 2) ** 2
      + Math.cos(rad(gs.lat)) * Math.cos(rad(lat)) * Math.sin(rad(lng - gs.lng) / 2) ** 2;
    const horizontal = 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return { horizontal, slant: Math.hypot(horizontal, alt - gs.alt) };
  }
  const radarHill = { lat: 67.87964, lng: 21.062234, alt: 484, name: "Radar Hill", source: "operator" };

  it("knows no position until the page reports one, and refuses a bad one", async () => {
    assert.equal((await get("/gs/position")).json().position, null);
    const bad = await post("/gs/position", { ...radarHill, lat: 200 });
    assert.equal(bad.status, 400);
    assert.match(bad.json().error, /lat/);
    assert.equal((await post("/gs/position", "{nope")).status, 400);
    assert.equal((await get("/gs/position")).json().position, null);
  });

  it("writes the position as the first event of the session and the distances on every row", async () => {
    const reply = (await post("/gs/position", radarHill)).json();
    assert.equal(reply.ok, true);
    assert.equal(reply.changed, true);
    assert.equal((await get("/gs/position")).json().position.name, "Radar Hill");

    await packetAt(1);                                // the first packet starts the session
    await until(async () => (await elinkRows()) >= 1, 4000, "first row logged");

    const events = positionEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0][2], "OPERATOR");
    assert.equal(events[0][7], "lat=67.8796400;lng=21.0622340;alt=484;name=Radar Hill");

    const { columns, rows } = newestRows("elink_live_");
    assert.deepEqual(columns.slice(-2), ["gsDistHorizontalM", "gsDistSlantM"]);
    const want = expected(radarHill, 67.8908, 21.0803, 343);
    assert.ok(Math.abs(Number(rows[0][columns.indexOf("gsDistHorizontalM")]) - want.horizontal) < 0.1);
    assert.ok(Math.abs(Number(rows[0][columns.indexOf("gsDistSlantM")]) - want.slant) < 0.1);
    assert.ok(want.horizontal > 1400 && want.horizontal < 1500, "Radar Hill to the MPF is about 1.45 km");
  });

  it("logs a changed position as a new event and uses it from the next packet", async () => {
    const moved = { ...radarHill, alt: 500, name: "Radar Hill, tripod" };
    assert.equal((await post("/gs/position", moved)).json().changed, true);
    assert.equal(positionEvents().length, 2);
    assert.ok(!positionEvents()[1][7].includes("Radar Hill,"), "a comma would break the CSV row");

    await packetAt(2);
    await until(async () => (await elinkRows()) >= 2, 4000, "second row logged");
    const { columns, rows } = newestRows("elink_live_");
    const want = expected(moved, 67.8908, 21.0803, 343);
    assert.ok(Math.abs(Number(rows[1][columns.indexOf("gsDistSlantM")]) - want.slant) < 0.1);
  });

  it("does not repeat the event when the page reports the same position again", async () => {
    const again = (await post("/gs/position", { ...radarHill, alt: 500, name: "Radar Hill, tripod" })).json();
    assert.equal(again.changed, false);
    assert.equal(positionEvents().length, 2);
  });

  it("logs the campaign default as DEFAULT and gives no distances from it", async () => {
    await post("/gs/position", { lat: 67.8856, lng: 21.0786, alt: 310, name: "Esrange Space Center", source: "default" });
    assert.equal(positionEvents().at(-1)![2], "DEFAULT");

    await packetAt(3);
    await until(async () => (await elinkRows()) >= 3, 4000, "third row logged");
    const { columns, rows } = newestRows("elink_live_");
    assert.equal(rows[2][columns.indexOf("gsDistHorizontalM")], "");
    assert.equal(rows[2][columns.indexOf("gsDistSlantM")], "");
  });

  it("puts the distances on the packets the page receives, once the operator has set the position", async () => {
    const feed = new Feed(backend.httpPort);
    await feed.opened();
    await post("/gs/position", radarHill);
    await packetAt(4);
    await until(() => feed.ofType("elink_telemetry").length >= 1, 3000, "telemetry on the socket");
    const data = feed.ofType("elink_telemetry")[0].data;
    const want = expected(radarHill, 67.8908, 21.0803, 343);
    assert.ok(Math.abs(data.gsDistHorizontalM - want.horizontal) < 0.1);
    assert.ok(feed.ofType("gs_position").length >= 1, "the new position is announced to the open pages");
    feed.close();
  });
});

describe("ground station backend — one folder per mission", () => {
  let root: string;
  let backend: Backend;
  let payload: ReturnType<typeof startPayloadSimulator>;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bless-e2e-mission-"));
    backend = await startBackend(path.join(root, "work"), path.join(root, "control"), { ROUTE_SAVE_INTERVAL_MS: "300" });
    payload = startPayloadSimulator(backend.payloadPort);
  });

  after(async () => {
    await payload?.close();
    await backend?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = (p: string) => request(backend.httpPort, "GET", p);
  const post = (p: string, body?: string | object) => request(backend.httpPort, "POST", p, body);
  const logsRoot = () => path.join(backend.workDir, "logs");
  const missionFolders = () =>
    fs.readdirSync(logsRoot(), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("mission_")).map((e) => e.name).sort();
  const readConfig = (folder: string) => {
    const session = folder.slice("mission_".length);
    return JSON.parse(fs.readFileSync(path.join(logsRoot(), folder, `mission_config_${session}.json`), "utf-8"));
  };
  const elinkRows = async () => (await get("/status")).json().logging.elinkRows as number;
  const radarHill = { lat: 67.87964, lng: 21.062234, alt: 484, name: "Radar Hill", source: "operator" };

  it("writes nothing to disk, and queues nothing, for a change made before REC", async () => {
    await until(async () => (await get("/status")).json().halow.connected === true, 5000, "HaLow module connected");
    assert.equal((await post("/halow/config", { name: "TXPOWER", value: "9" })).json().ok, true);
    await post("/gs/position", radarHill);
    assert.deepEqual(missionFolders(), []);
    assert.deepEqual(logFiles(backend.workDir, "mission_events_"), []);
    assert.equal((await get("/status")).json().logging.active, false, "a freshly started backend is not recording");
  });

  it("creates mission_<session> with every file of the run when REC starts", async () => {
    await sendUdp(backend.udpPort, telemetryPacket({ count: 1, lat: 67.8908, lng: 21.0803, alt: 343 }));
    await until(async () => (await elinkRows()) >= 1, 4000, "first packet logged");

    const folders = missionFolders();
    assert.equal(folders.length, 1);
    assert.equal((await get("/status")).json().logging.active, true, "the first packet of a run starts REC by itself");
    assert.equal((await get("/status")).json().mission.folder, folders[0]);

    const names = fs.readdirSync(path.join(logsRoot(), folders[0]));
    const session = folders[0].slice("mission_".length);
    for (const prefix of ["halow_live_", "elink_live_", "gs_rf_live_", "mission_events_"]) {
      assert.ok(names.includes(`${prefix}${session}.csv`), `${prefix} is in the folder`);
    }
    assert.ok(names.includes(`mission_config_${session}.json`));
    // nothing else is left loose at the top of logs/ except the route journal
    const loose = fs.readdirSync(logsRoot(), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
    assert.deepEqual(loose.filter((n) => n.endsWith(".csv") || n.endsWith(".json")), []);

    const events = fs.readFileSync(path.join(logsRoot(), folders[0], `mission_events_${session}.csv`), "utf-8");
    assert.equal(/GROUND_HALOW_CONFIG/.test(events), false, "the change made before REC is not replayed into the file");
    assert.match(events, /GROUND_STATION_POSITION,,OPERATOR/);
  });

  it("the mission configuration says where the GS was, how its radio was set and what the payload runs", async () => {
    const config = readConfig(missionFolders()[0]);
    assert.equal(config.schema, 1);
    assert.equal(config.mission.endedAt, null);
    assert.equal(config.groundStation.position.name, "Radar Hill");
    assert.equal(config.groundStation.position.alt, 484);
    assert.equal(config.groundStation.radio.txPower.dBm, 9);
    assert.equal(config.groundStation.radio.txPower.origin, "applied-from-software");
    assert.equal(config.groundStation.radio.appliedFromSoftware.TXPOWER.value, "9");
    assert.equal(config.groundStation.equipment.confirmedByOperator, false);
    assert.equal(config.payload.txPower.dBm, null, "the payload's own power is not guessed");
    assert.equal(config.payload.txPower.origin, "not-changed-this-run");
    assert.equal(Object.keys(config.groundStation.equipment).includes("payloadAntenna"), false);
    assert.ok(config.mission.files.some((f: string) => f.startsWith("halow_live_")));
  });

  it("saves the mission's route as GeoJSON in its folder, already while recording", async () => {
    const folder = missionFolders()[0];
    const session = folder.slice("mission_".length);
    const file = path.join(logsRoot(), folder, `route_${session}.geojson`);
    for (let i = 1; i <= 3; i++) {
      await sendUdp(backend.udpPort, telemetryPacket({ count: 10 + i, lat: 67.8908 + i * 0.001, lng: 21.0803 + i * 0.001, alt: 343 + i }));
      await sleep(80);
    }
    const written = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : null);
    await until(() => (written()?.bless.points ?? 0) >= 4, 5000, "route written while recording");

    const geo = written();
    assert.equal(geo.type, "FeatureCollection");
    assert.equal(geo.bless.session, session);
    assert.equal(geo.bless.reason, "recording");
    assert.ok(geo.features.some((f: any) => f.geometry.type === "LineString")); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.ok(readConfig(folder).mission.files.includes(`route_${session}.geojson`), "the configuration lists it");
  });

  it("keeps the configuration up to date as equipment, position and payload commands change", async () => {
    const bad = await post("/gs/equipment", { groundAntenna: { gainDbi: 400 } });
    assert.equal(bad.status, 400);

    const saved = await post("/gs/equipment", {
      groundAntenna: { gainDbi: 10, polarization: "vertical" },
      groundLna: { present: true, gainDb: 20 },
      groundCableLossDb: 1.5,
      notes: "Radar Hill, tripod",
    });
    assert.equal(saved.status, 200);
    assert.ok(fs.existsSync(path.join(backend.workDir, "station_equipment.json")), "equipment survives a restart");

    assert.equal((await post("/cmd/SET_TX_POWER", { params: [12] })).json().ok, true);
    assert.equal((await post("/gs/position", { ...radarHill, alt: 490 })).json().changed, true);

    const config = readConfig(missionFolders()[0]);
    assert.equal(config.groundStation.equipment.groundAntenna.gainDbi, 10);
    assert.equal(config.groundStation.equipment.confirmedByOperator, true);
    assert.equal(config.groundStation.equipmentChanges.length, 1);
    assert.equal(config.groundStation.positionChanges.length, 1);
    assert.equal(config.groundStation.positionChanges[0].position.alt, 490);
    assert.equal(config.payload.txPower.dBm, 12);
    assert.equal(config.payload.txPower.origin, "command");
    assert.equal(config.payload.commandsSent.filter((c: any) => c.command === "SET_TX_POWER").length, 1); // eslint-disable-line @typescript-eslint/no-explicit-any

    const events = fs.readFileSync(logFiles(backend.workDir, "mission_events_")[0], "utf-8");
    assert.match(events, /PAYLOAD_COMMAND,,SENT,,,.*,,SET_TX_POWER;params=12/);
  });

  it("lists the files of every mission and serves them, but nothing outside the log folders", async () => {
    const folder = missionFolders()[0];
    const session = folder.slice("mission_".length);
    const listed = (await get("/logs")).json() as string[];
    assert.ok(listed.includes(`${folder}/halow_live_${session}.csv`));
    assert.ok(listed.includes(`${folder}/mission_config_${session}.json`));
    assert.ok(listed.includes(`${folder}/route_${session}.geojson`));
    const route = await get(`/logs/${folder}/route_${session}.geojson`);
    assert.equal(route.status, 200);
    assert.match(String(route.headers["content-type"]), /geo\+json/);

    const csv = await get(`/logs/${folder}/elink_live_${session}.csv`);
    assert.equal(csv.status, 200);
    assert.match(String(csv.headers["content-type"]), /text\/csv/);
    const json = await get(`/logs/${folder}/mission_config_${session}.json`);
    assert.equal(json.status, 200);
    assert.equal(json.json().mission.session, session);

    assert.equal((await get(`/logs/${folder}/..%2F..%2Fpackage.json`)).status, 404);
    assert.equal((await get(`/logs/%2E%2E/${folder}/x.csv`)).status, 404);
    assert.equal((await get(`/logs/elsewhere/halow_live_${session}.csv`)).status, 404);
    assert.equal((await get(`/logs/${folder}/nope.csv`)).status, 404);
    assert.equal((await get(`/logs/${folder}/a/b.csv`)).status, 404);
  });

  it("keeps the mission's own route journal, one point per line, in its folder", async () => {
    const folder = missionFolders()[0];
    const session = folder.slice("mission_".length);
    const file = path.join(logsRoot(), folder, `route_${session}.ndjson`);
    assert.ok(fs.existsSync(file), "route_<session>.ndjson is in the mission folder");
    const points = fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(points.length >= 4);
    assert.ok(points.every((p: any) => typeof p.lat === "number" && typeof p.lng === "number" && (p.link === "halow" || p.link === "elink"))); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(readConfig(folder).mission.rows.route, points.length, "the configuration counts the same points");
    assert.ok(readConfig(folder).mission.files.includes(`route_${session}.ndjson`));

    const served = await get(`/logs/${folder}/route_${session}.ndjson`);
    assert.equal(served.status, 200);
    assert.match(String(served.headers["content-type"]), /ndjson/);
  });

  it("closes the folder at REC stop; a change between missions only shows in the next configuration", async () => {
    const first = missionFolders()[0];
    const stopped = (await post("/logging/stop")).json();
    assert.equal(stopped.active, false);
    assert.ok(readConfig(first).mission.endedAt, "the end time is written");
    const finalRoute = JSON.parse(fs.readFileSync(path.join(logsRoot(), first, `route_${first.slice("mission_".length)}.geojson`), "utf-8"));
    assert.equal(finalRoute.bless.reason, "rec-stop", "REC stop writes the final route");

    // a radio change between missions must not land in the finished folder
    assert.equal((await post("/halow/config", { name: "TXPOWER", value: "11" })).json().ok, true);
    const session = first.slice("mission_".length);
    const finished = fs.readFileSync(path.join(logsRoot(), first, `mission_events_${session}.csv`), "utf-8");
    assert.equal(finished.includes("TXPOWER=11"), false);
    assert.equal(readConfig(first).groundStation.radio.appliedFromSoftware.TXPOWER.value, "9");

    await sleep(1100);                                  // session names carry seconds
    await post("/logging/start");
    await until(() => missionFolders().length === 2, 3000, "second mission folder");
    const second = missionFolders()[1];
    const secondSession = second.slice("mission_".length);
    const events = fs.readFileSync(path.join(logsRoot(), second, `mission_events_${secondSession}.csv`), "utf-8");
    assert.equal(events.includes("TXPOWER=11"), false, "nothing is queued from between the missions");
    assert.equal(readConfig(second).groundStation.radio.txPower.dBm, 11, "the configuration does say it, with its time");
    assert.ok(readConfig(second).groundStation.radio.appliedFromSoftware.TXPOWER.at);
    // the position and equipment are not asked for again: they carry over
    assert.equal(readConfig(second).groundStation.position.name, "Radar Hill");
    assert.equal(readConfig(second).groundStation.equipment.groundAntenna.polarization, "vertical");

    // each mission's route journal holds only its own points
    for (let i = 0; i < 2; i++) {
      await sendUdp(backend.udpPort, telemetryPacket({ count: 500 + i, lat: 67.95 + i * 0.002, lng: 21.2 + i * 0.002, alt: 900 + i }));
      await sleep(80);
    }
    const journal = (folder: string) => fs.readFileSync(
      path.join(logsRoot(), folder, `route_${folder.slice("mission_".length)}.ndjson`), "utf-8",
    ).trim().split("\n").map((l) => JSON.parse(l).pkt as number);
    await until(() => fs.existsSync(path.join(logsRoot(), second, `route_${secondSession}.ndjson`)) && journal(second).length >= 2, 4000, "second journal");
    assert.deepEqual(journal(second), [500, 501]);
    assert.equal(journal(missionFolders()[0]).some((n) => n >= 500), false, "the first mission's journal is closed");
  });

  it("keeps the saved equipment in its own file and serves it back", async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(backend.workDir, "station_equipment.json"), "utf-8"));
    assert.equal(saved.groundLna.gainDb, 20);
    assert.equal((await get("/gs/equipment")).json().equipment.notes, "Radar Hill, tripod");
  });
});
