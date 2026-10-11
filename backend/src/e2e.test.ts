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
    const logs = fs.readdirSync(path.join(backend.workDir, "logs")).filter((f) => f.startsWith("mission_events"));
    for (const file of logs) {
      assert.equal(fs.readFileSync(path.join(backend.workDir, "logs", file), "utf-8").includes("supersecretpassword1"), false);
    }
  });

  it("records every ground radio change in the mission events file", async () => {
    const files = fs.readdirSync(path.join(backend.workDir, "logs")).filter((f) => f.startsWith("mission_events"));
    const content = files.map((f) => fs.readFileSync(path.join(backend.workDir, "logs", f), "utf-8")).join("\n");
    assert.match(content, /GROUND_HALOW_CONFIG,,OK,.*TXPOWER=12/);
    assert.match(content, /GROUND_HALOW_CONFIG,,FAILED,.*TXPOWER=19/);
    assert.match(content, /GROUND_HALOW_CONFIG,,FAILED,.*TX_MCS=5/);
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
    const csv = fs.readdirSync(path.join(backend.workDir, "logs")).filter((f) => f.startsWith("halow_live_"));
    assert.ok(csv.length >= 1);
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

    const filesBefore = fs.readdirSync(path.join(backend.workDir, "logs")).filter((f) => f.startsWith("halow_live_")).length;
    await sleep(1100);                                   // timestamped session names need a new second
    await post("/logging/start");
    await until(async () => (await get("/status")).json().logging.halowRows > 0, 3000, "rows in the new session");
    const filesAfter = fs.readdirSync(path.join(backend.workDir, "logs")).filter((f) => f.startsWith("halow_live_")).length;
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
    const elinkRows = fs.readdirSync(logsDir).filter((f) => f.startsWith("elink_live_"))
      .map((f) => fs.readFileSync(path.join(logsDir, f), "utf-8").trim().split("\n").length - 1)
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
  it("restores the recorded route after the backend restarts, and clears it for good", async () => {
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

      backend = await startBackend(work, control);
      const restored = (await request(backend.httpPort, "GET", "/route")).json();
      assert.equal(restored.length, 3);
      assert.deepEqual(restored.map((p: any) => p.rssi), [-60, -65, -70]); // eslint-disable-line @typescript-eslint/no-explicit-any
      assert.ok(restored.every((p: any) => p.link === "elink")); // eslint-disable-line @typescript-eslint/no-explicit-any

      await request(backend.httpPort, "POST", "/route/clear");
      await backend.stop();
      backend = await startBackend(work, control);
      assert.deepEqual((await request(backend.httpPort, "GET", "/route")).json(), []);
    } finally {
      await backend?.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
