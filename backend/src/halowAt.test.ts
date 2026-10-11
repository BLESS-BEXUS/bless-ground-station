import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionEventLogger } from "./logger";
import {
  AtCommandChannel,
  classifyResponseLine,
  displayValue,
  formatAtCommand,
  validateAtCommand,
} from "./halowAt";

test("commands are formatted like the payload firmware does", () => {
  assert.equal(formatAtCommand("TXPOWER", "9"), "AT+TXPOWER=9\r\n");
  assert.equal(formatAtCommand("FREQ_RANGE", "8660,8670"), "AT+FREQ_RANGE=8660,8670\r\n");
});

test("values are validated against the limits the payload enforces", () => {
  assert.deepEqual(validateAtCommand("TXPOWER", " 12 "), { ok: true, value: "12" });
  assert.equal(validateAtCommand("TXPOWER", "5").ok, false);
  assert.equal(validateAtCommand("TXPOWER", "21").ok, false);
  assert.equal(validateAtCommand("TXPOWER", "9.5").ok, false);

  assert.deepEqual(validateAtCommand("TX_MCS", "7"), { ok: true, value: "7" });
  assert.equal(validateAtCommand("TX_MCS", "8").ok, false);

  assert.deepEqual(validateAtCommand("BSS_BW", "1"), { ok: true, value: "1" });
  assert.equal(validateAtCommand("BSS_BW", "3").ok, false);

  assert.deepEqual(validateAtCommand("FREQ_RANGE", "8660, 8670"), { ok: true, value: "8660,8670" });
  assert.equal(validateAtCommand("FREQ_RANGE", "8670,8660").ok, false);
  assert.equal(validateAtCommand("FREQ_RANGE", "866,867").ok, false);
  assert.equal(validateAtCommand("FREQ_RANGE", "1000,1010").ok, false);

  assert.deepEqual(validateAtCommand("ACKTMO", "2990"), { ok: true, value: "2990" });
  assert.deepEqual(validateAtCommand("MODE", "sta"), { ok: true, value: "STA" });
  assert.equal(validateAtCommand("MODE", "MESH").ok, false);
  assert.equal(validateAtCommand("NOPE", "1").ok, false);
});

test("a value cannot smuggle a second command", () => {
  assert.equal(validateAtCommand("SSID", "bless\r\nAT+TXPOWER=20").ok, false);
  assert.equal(validateAtCommand("PSK", "pass\nword123").ok, false);
  assert.equal(validateAtCommand("TXPOWER", "9\r\nAT+MODE=AP").ok, false);
});

test("the PSK is never shown back", () => {
  assert.equal(displayValue("PSK", "78a0c6ee134c"), "********");
  assert.equal(displayValue("TXPOWER", "9"), "9");
});

test("only OK and ERROR lines answer a command, never telemetry statistics", () => {
  assert.equal(classifyResponseLine("OK"), "ok");
  assert.equal(classifyResponseLine("+OK"), "ok");
  assert.equal(classifyResponseLine("ERROR"), "error");
  assert.equal(classifyResponseLine("ERROR: bad value"), "error");
  assert.equal(classifyResponseLine("rx0: rssi=-60 snr=34 mcs=0 bw=1MHz OK"), "other");
  assert.equal(classifyResponseLine("tx0: snr=34 per=0 OK"), "other");
  assert.equal(classifyResponseLine("+RXDATA:67"), "other");
  assert.equal(classifyResponseLine("TXPOWER=9"), "other");
});

test("a command completes when the module answers OK", async () => {
  const written: string[] = [];
  const channel = new AtCommandChannel((data) => written.push(data), 200, 3);
  const pending = channel.send("TXPOWER", "12");
  assert.deepEqual(written, ["AT+TXPOWER=12\r\n"]);
  assert.equal(channel.handleLine("TXPOWER=12"), false);
  assert.equal(channel.handleLine("OK"), true);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.response, ["TXPOWER=12", "OK"]);
});

test("an ERROR answer is reported and not retried", async () => {
  const written: string[] = [];
  const channel = new AtCommandChannel((data) => written.push(data), 200, 3);
  const pending = channel.send("TX_MCS", "7");
  channel.handleLine("ERROR");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /ERROR/);
  assert.equal(written.length, 1);
});

test("silence is retried like the payload does, then reported", async () => {
  const written: string[] = [];
  const channel = new AtCommandChannel((data) => written.push(data), 20, 3);
  const result = await channel.send("TXPOWER", "9");
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(written.length, 3);
  assert.match(result.error ?? "", /No OK/);
});

test("commands run one at a time, in order", async () => {
  const written: string[] = [];
  const channel = new AtCommandChannel((data) => written.push(data), 200, 1);
  const first = channel.send("TXPOWER", "10");
  const second = channel.send("TX_MCS", "2");
  assert.deepEqual(written, ["AT+TXPOWER=10\r\n"]);   // the second waits for the first
  channel.handleLine("OK");
  await first;
  assert.deepEqual(written, ["AT+TXPOWER=10\r\n", "AT+TX_MCS=2\r\n"]);
  channel.handleLine("OK");
  assert.equal((await second).ok, true);
});

test("a late OK with nothing pending is ignored", () => {
  const channel = new AtCommandChannel(() => undefined, 50, 1);
  assert.equal(channel.handleLine("OK"), false);
});

test("closing the port fails the pending and queued commands without sending more", async () => {
  const written: string[] = [];
  const channel = new AtCommandChannel((data) => written.push(data), 500, 3);
  const first = channel.send("TXPOWER", "10");
  const second = channel.send("TX_MCS", "2");
  channel.abortAll("serial port closed");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.equal(written.length, 1);
});

test("a write failure is reported immediately", async () => {
  const channel = new AtCommandChannel(() => { throw new Error("port not open"); }, 50, 3);
  const result = await channel.send("TXPOWER", "9");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /port not open/);
});

test("a radio change is written to the mission events file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bless-radio-"));
  try {
    const logger = new MissionEventLogger(directory, "mission_events.csv");
    logger.start("test");
    logger.writeGroundRadioConfig({
      status: "OK",
      setting: "TXPOWER=12",
      sentUtc: "2026-10-11T10:00:00.000Z",
      finishedUtc: "2026-10-11T10:00:00.120Z",
    });
    const content = fs.readFileSync(logger.getFilePath(), "utf-8");
    assert.match(content, /GROUND_HALOW_CONFIG,,OK,,,2026-10-11T10:00:00.000Z,2026-10-11T10:00:00.120Z,TXPOWER=12/);
    assert.equal(logger.getRowCount(), 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a module that echoes the PSK does not expose it in the response", async () => {
  const channel = new AtCommandChannel(() => undefined, 200, 1);
  const pending = channel.send("PSK", "supersecretpassword1");
  channel.handleLine("PSK=supersecretpassword1");
  channel.handleLine("OK");
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.value, "********");
  assert.equal(JSON.stringify(result).includes("supersecretpassword1"), false);
  assert.deepEqual(result.response, ["PSK=********", "OK"]);
});
