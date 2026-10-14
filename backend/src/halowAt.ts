/**
 * AT interface of the ground-station T-HaLow module.
 *
 * It mirrors what the payload firmware does to its own module (BLESS-Source-Code,
 * Core/Src/txhalow.c): `AT+<NAME>=<value>\r\n`, then wait up to 1 s for a line
 * containing OK (done) or ERROR (rejected), retrying up to 3 times when silent.
 * The limits are the ones the payload enforces (Core/Inc/txhalow.h).
 */

export const GROUND_AT_COMMANDS = [
  "TXPOWER",
  "TX_MCS",
  "BSS_BW",
  "FREQ_RANGE",
  "ACKTMO",
  "MODE",
  "SSID",
  "PSK",
  // Read-outs and group setup (LilyGO T-Halow-RJ45 docs/AT_cmd.md)
  "RSSI",
  "JOINGROUP",
  "SYSDBG",
] as const;

export type GroundAtCommand = (typeof GROUND_AT_COMMANDS)[number];

export const TX_POWER_MIN_DBM = 6;
export const TX_POWER_MAX_DBM = 20;
export const TX_MCS_MIN = 0;
export const TX_MCS_MAX = 7;

/** Values that must not be echoed into logs or the UI history. */
const SECRET_COMMANDS: readonly string[] = ["PSK"];

export type AtValidation = { ok: true; value: string } | { ok: false; error: string };

function integerIn(raw: string, min: number, max: number, label: string): AtValidation {
  if (!/^-?\d+$/.test(raw)) return { ok: false, error: `${label} must be a whole number` };
  const n = Number(raw);
  if (n < min || n > max) return { ok: false, error: `${label} must be between ${min} and ${max}` };
  return { ok: true, value: String(n) };
}

export function isGroundAtCommand(name: string): name is GroundAtCommand {
  return (GROUND_AT_COMMANDS as readonly string[]).includes(name);
}

export function validateAtCommand(name: string, rawValue: string): AtValidation {
  if (!isGroundAtCommand(name)) return { ok: false, error: `Unknown command ${name}` };
  const raw = rawValue.trim();
  // Anything that could end the line early would let a value smuggle a second command
  if (/[\r\n\0]/.test(raw)) return { ok: false, error: "Value contains control characters" };

  switch (name) {
    case "TXPOWER":
      return integerIn(raw, TX_POWER_MIN_DBM, TX_POWER_MAX_DBM, "TX power (dBm)");
    case "TX_MCS":
      return integerIn(raw, TX_MCS_MIN, TX_MCS_MAX, "MCS");
    case "BSS_BW":
      return ["1", "2", "4", "8"].includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: "Bandwidth must be 1, 2, 4 or 8 (MHz)" };
    case "FREQ_RANGE": {
      // Two numbers in 100 kHz units, e.g. 8660,8670 = 866.0 to 867.0 MHz
      const match = /^(\d{4})\s*,\s*(\d{4})$/.exec(raw);
      if (!match) return { ok: false, error: "Frequency range must look like 8660,8670 (100 kHz units)" };
      const [start, end] = [Number(match[1]), Number(match[2])];
      if (start < 7500 || end > 9300) return { ok: false, error: "Frequency range must be within 750.0 and 930.0 MHz" };
      if (start >= end) return { ok: false, error: "Frequency range start must be below its end" };
      return { ok: true, value: `${start},${end}` };
    }
    case "ACKTMO":
      return integerIn(raw, 0, 65535, "ACK timeout");
    case "MODE":
      return ["AP", "STA", "GROUP"].includes(raw.toUpperCase())
        ? { ok: true, value: raw.toUpperCase() }
        : { ok: false, error: "Mode must be AP, STA or GROUP" };
    case "RSSI":
      // Device index (1..N) or the peer's MAC address
      return /^\d{1,3}$/.test(raw) && Number(raw) >= 1
        || /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(raw)
        ? { ok: true, value: raw.toLowerCase() }
        : { ok: false, error: "RSSI takes a device index (1, 2, ...) or a MAC address" };
    case "JOINGROUP": {
      // group address and AID; AID 0 = no heartbeats (one-way broadcast)
      const match = /^((?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s*,\s*(\d{1,3})$/i.exec(raw);
      return match
        ? { ok: true, value: `${match[1].toLowerCase()},${Number(match[2])}` }
        : { ok: false, error: "JOINGROUP takes a group address and an AID, e.g. 11:22:33:44:55:66,0" };
    }
    case "SYSDBG": {
      const match = /^(LMAC|WNB)\s*,\s*([01])$/i.exec(raw);
      return match
        ? { ok: true, value: `${match[1].toUpperCase()},${match[2]}` }
        : { ok: false, error: "SYSDBG takes LMAC or WNB and 0 or 1, e.g. LMAC,1" };
    }
    case "SSID":
      return /^[\x20-\x7e]{1,32}$/.test(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: "SSID must be 1-32 printable characters" };
    case "PSK":
      return /^[\x21-\x7e]{8,64}$/.test(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: "PSK must be 8-64 printable characters without spaces" };
  }
}

export function formatAtCommand(name: GroundAtCommand, value: string): string {
  return `AT+${name}=${value}\r\n`;
}

/** What may be shown or logged for a command (secrets are hidden). */
export function displayValue(name: string, value: string): string {
  return SECRET_COMMANDS.includes(name) ? "********" : value;
}

export type LineClass = "ok" | "error" | "other";

export function classifyResponseLine(line: string): LineClass {
  // Telemetry statistics and frame announcements are not command responses
  if (line.startsWith("rx0:") || line.startsWith("tx0:") || line.startsWith("+RXDATA")) return "other";
  if (/\bERROR\b/.test(line)) return "error";
  if (/\bOK\b/.test(line)) return "ok";
  return "other";
}

export interface AtResult {
  ok: boolean;
  name: GroundAtCommand;
  /** Value as sent (secrets masked). */
  value: string;
  attempts: number;
  /** Lines the module printed while the command was pending. */
  response: string[];
  error?: string;
  sentAt: string;
  finishedAt: string;
}

interface Job {
  name: GroundAtCommand;
  value: string;
  resolve: (result: AtResult) => void;
  attempts: number;
  response: string[];
  sentAt: string;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Sends one AT command at a time and matches the module's OK / ERROR answer. */
export class AtCommandChannel {
  private readonly queue: Job[] = [];
  private current: Job | null = null;

  constructor(
    private readonly write: (data: string) => void,
    private readonly timeoutMs = 1000,
    private readonly maxAttempts = 3,
  ) {}

  send(name: GroundAtCommand, value: string): Promise<AtResult> {
    return new Promise((resolve) => {
      this.queue.push({
        name, value, resolve, attempts: 0, response: [], sentAt: new Date().toISOString(), timer: null,
      });
      this.next();
    });
  }

  /** Feed every text line from the module. Returns true when it answered the pending command. */
  handleLine(line: string): boolean {
    const job = this.current;
    if (!job) return false;
    const kind = classifyResponseLine(line);
    if (kind === "other") {
      // keep what the module says while we wait (echo, values), but not telemetry stats
      if (!line.startsWith("rx0:") && !line.startsWith("tx0:") && !line.startsWith("+RXDATA")) {
        job.response.push(line);
      }
      return false;
    }
    job.response.push(line);
    this.finish(job, kind === "ok" ? undefined : `Module answered ERROR to AT+${job.name}`);
    return true;
  }

  /** The serial port went away: fail whatever is waiting. */
  abortAll(reason: string): void {
    // Empty the queue first so finishing the current job cannot start the next one
    const waiting = this.queue.splice(0);
    if (this.current) this.finish(this.current, reason);
    for (const job of waiting) job.resolve(this.result(job, reason));
  }

  private next(): void {
    if (this.current || this.queue.length === 0) return;
    const job = this.queue.shift() as Job;
    this.current = job;
    this.transmit(job);
  }

  private transmit(job: Job): void {
    job.attempts++;
    try {
      this.write(formatAtCommand(job.name, job.value));
    } catch (err) {
      this.finish(job, `Could not write to the serial port: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    job.timer = setTimeout(() => {
      if (this.current !== job) return;
      if (job.attempts < this.maxAttempts) this.transmit(job);
      else this.finish(job, `No OK from the module after ${job.attempts} attempts`);
    }, this.timeoutMs);
  }

  private finish(job: Job, error?: string): void {
    if (job.timer) clearTimeout(job.timer);
    if (this.current === job) this.current = null;
    job.resolve(this.result(job, error));
    this.next();
  }

  private result(job: Job, error?: string): AtResult {
    // A module that echoes the command would otherwise show a secret in clear
    const secret = SECRET_COMMANDS.includes(job.name) && job.value !== "";
    const response = secret
      ? job.response.map((line) => line.split(job.value).join(displayValue(job.name, job.value)))
      : job.response;
    return {
      ok: error === undefined,
      name: job.name,
      value: displayValue(job.name, job.value),
      attempts: job.attempts,
      response,
      error,
      sentAt: job.sentAt,
      finishedAt: new Date().toISOString(),
    };
  }
}
