import { useCallback, useEffect, useState, type ReactNode } from "react";
import { HTTP_URL } from "@/lib/backendUrl";
import {
  ackTimeoutFor,
  BANDWIDTH_OPTIONS,
  changeBreaksLink,
  distanceForAckTimeout,
  freqRangeValue,
  MCS_OPTIONS,
  parseFreqRange,
  PAYLOAD_MISSION_DEFAULTS,
  TX_POWER_RANGE,
  type GroundAtCommand,
} from "@/lib/groundRadio";

interface AtResult {
  ok: boolean;
  name: GroundAtCommand;
  value: string;
  attempts: number;
  response: string[];
  error?: string;
  sentAt: string;
  finishedAt: string;
}

interface ConfigStatus {
  connected: boolean;
  disabled: boolean;
  port: string;
  commands: GroundAtCommand[];
  applied: Partial<Record<GroundAtCommand, { value: string; at: string }>>;
  history: AtResult[];
}

const ALL_COMMANDS: GroundAtCommand[] = [
  "TXPOWER", "TX_MCS", "BSS_BW", "FREQ_RANGE", "ACKTMO", "MODE", "SSID", "PSK",
  "RSSI", "JOINGROUP", "SYSDBG",
];

const inputClass =
  "bg-background border border-border rounded px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary/60 disabled:opacity-50";

async function fetchStatus(): Promise<ConfigStatus | null> {
  try {
    const res = await fetch(`${HTTP_URL}/halow/config`);
    return res.ok ? ((await res.json()) as ConfigStatus) : null;
  } catch {
    return null;
  }
}

async function runCommand(name: GroundAtCommand, value: string): Promise<AtResult | { ok: false; error: string }> {
  try {
    const res = await fetch(`${HTTP_URL}/halow/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value }),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: `Backend not reachable (${String(e)})` };
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export default function GroundRadioPage() {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [busy, setBusy] = useState<GroundAtCommand | null>(null);
  const [outcome, setOutcome] = useState<Partial<Record<GroundAtCommand, { ok: boolean; text: string }>>>({});

  // Inputs
  const [txPower, setTxPower] = useState<string>(PAYLOAD_MISSION_DEFAULTS.TXPOWER);
  const [mcs, setMcs] = useState<string>(PAYLOAD_MISSION_DEFAULTS.TX_MCS);
  const [bandwidth, setBandwidth] = useState<string>(PAYLOAD_MISSION_DEFAULTS.BSS_BW);
  const initialRange = parseFreqRange(PAYLOAD_MISSION_DEFAULTS.FREQ_RANGE);
  const [startMHz, setStartMHz] = useState(String(initialRange?.startMHz ?? 866));
  const [endMHz, setEndMHz] = useState(String(initialRange?.endMHz ?? 867));
  const [distanceKm, setDistanceKm] = useState(
    String(distanceForAckTimeout(Number(PAYLOAD_MISSION_DEFAULTS.ACKTMO))),
  );
  const [rawName, setRawName] = useState<GroundAtCommand>("TXPOWER");
  const [rawValue, setRawValue] = useState("");
  const [rawOutcome, setRawOutcome] = useState<{ name: GroundAtCommand; ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => setStatus(await fetchStatus()), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ready = status !== null && status.connected && !status.disabled;

  async function apply(name: GroundAtCommand, value: string, fromAdvanced = false) {
    if (changeBreaksLink(name)) {
      const ok = window.confirm(
        `AT+${name}=${name === "PSK" ? "********" : value}\n\n`
        + "This changes the radio link itself. If the payload does not use the same value, "
        + "the link is lost until both ends match. Continue?",
      );
      if (!ok) return;
    }
    setBusy(name);
    const result = await runCommand(name, value);
    const shown = result.ok
      ? { ok: true, text: `Applied (${"attempts" in result && result.attempts > 1 ? `${result.attempts} attempts` : "OK"})` }
      : { ok: false, text: result.error ?? "Failed" };
    if (fromAdvanced) setRawOutcome({ name, ...shown });
    else setOutcome((prev) => ({ ...prev, [name]: shown }));
    setBusy(null);
    void refresh();
  }

  const ackValue = ackTimeoutFor(Number(distanceKm));
  const rangeValue = freqRangeValue(Number(startMHz), Number(endMHz));

  // Empty or half-typed fields must not become "NaN" on the wire
  const powerNumber = Number(txPower);
  const powerValid = txPower.trim() !== ""
    && Number.isInteger(powerNumber)
    && powerNumber >= TX_POWER_RANGE.min && powerNumber <= TX_POWER_RANGE.max;
  const rangeValid = startMHz.trim() !== "" && endMHz.trim() !== ""
    && Number.isFinite(Number(startMHz)) && Number.isFinite(Number(endMHz))
    && Number(startMHz) >= 750 && Number(endMHz) <= 930 && Number(startMHz) < Number(endMHz);
  const ackValid = distanceKm.trim() !== "" && Number.isFinite(ackValue);

  const applied = (name: GroundAtCommand) => status?.applied[name];

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="rounded-lg border border-tertiary/30 bg-card p-4 space-y-1">
        <p className="font-mono text-sm text-tertiary">
          Ground-station HaLow module — {status ? `port ${status.port}` : "backend not reachable"}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          These commands go to the T-HaLow plugged into this computer (the ground station), not to the
          payload. They are the same AT commands the payload firmware uses on its own module. For the
          payload, use the E-Link commands.
        </p>
      </div>

      {!ready && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 font-mono text-sm text-warning">
          {status === null
            ? "Cannot reach the backend."
            : status.disabled
              ? "This ground station has no HaLow module (HALOW_PORT=none)."
              : `The HaLow serial port ${status.port} is not open.`}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        <Row
          title="TX power"
          command="AT+TXPOWER"
          description={`Transmit power of the ground module (uplink to the payload). The payload accepts ${TX_POWER_RANGE.min}–${TX_POWER_RANGE.max} dBm; its mission value is ${PAYLOAD_MISSION_DEFAULTS.TXPOWER} dBm.`}
          applied={applied("TXPOWER") && `${applied("TXPOWER")?.value} dBm at ${formatTime(applied("TXPOWER")!.at)}`}
          outcome={outcome.TXPOWER}
          busy={busy === "TXPOWER"}
          disabled={!ready || busy !== null}
          onApply={() => apply("TXPOWER", txPower)}
          invalid={!powerValid && `Enter a whole number from ${TX_POWER_RANGE.min} to ${TX_POWER_RANGE.max}`}
        >
          <input
            type="number" min={TX_POWER_RANGE.min} max={TX_POWER_RANGE.max} step={1}
            value={txPower} onChange={(e) => setTxPower(e.target.value)}
            className={`${inputClass} w-28`}
          />
          <span className="font-mono text-xs text-muted-foreground">dBm</span>
        </Row>

        <Row
          title="TX MCS"
          command="AT+TX_MCS"
          description="Modulation and coding the ground module transmits with. Lower is more robust and slower; the payload's mission value is MCS0."
          applied={applied("TX_MCS") && `MCS${applied("TX_MCS")?.value} at ${formatTime(applied("TX_MCS")!.at)}`}
          outcome={outcome.TX_MCS}
          busy={busy === "TX_MCS"}
          disabled={!ready || busy !== null}
          onApply={() => apply("TX_MCS", mcs)}
        >
          <select value={mcs} onChange={(e) => setMcs(e.target.value)} className={`${inputClass} w-72`}>
            {MCS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Row>

        <Row
          title="Bandwidth"
          command="AT+BSS_BW"
          description={`Channel width. Must match the payload (${PAYLOAD_MISSION_DEFAULTS.BSS_BW} MHz): if only one end changes, the link is lost.`}
          applied={applied("BSS_BW") && `${applied("BSS_BW")?.value} MHz at ${formatTime(applied("BSS_BW")!.at)}`}
          outcome={outcome.BSS_BW}
          busy={busy === "BSS_BW"}
          disabled={!ready || busy !== null}
          onApply={() => apply("BSS_BW", bandwidth)}
          warn
        >
          <select value={bandwidth} onChange={(e) => setBandwidth(e.target.value)} className={`${inputClass} w-28`}>
            {BANDWIDTH_OPTIONS.map((bw) => (
              <option key={bw} value={bw}>{bw} MHz</option>
            ))}
          </select>
        </Row>

        <Row
          title="Frequency range"
          command="AT+FREQ_RANGE"
          description={`Operating band. Must match the payload (${PAYLOAD_MISSION_DEFAULTS.FREQ_RANGE} = 866.0–867.0 MHz). Sent as ${rangeValue}.`}
          applied={applied("FREQ_RANGE") && `${applied("FREQ_RANGE")?.value} at ${formatTime(applied("FREQ_RANGE")!.at)}`}
          outcome={outcome.FREQ_RANGE}
          busy={busy === "FREQ_RANGE"}
          disabled={!ready || busy !== null}
          onApply={() => apply("FREQ_RANGE", rangeValue)}
          invalid={!rangeValid && "Enter a start below the end, within 750 and 930 MHz"}
          warn
        >
          <input
            type="number" step={0.1} value={startMHz} onChange={(e) => setStartMHz(e.target.value)}
            className={`${inputClass} w-28`}
          />
          <span className="font-mono text-xs text-muted-foreground">to</span>
          <input
            type="number" step={0.1} value={endMHz} onChange={(e) => setEndMHz(e.target.value)}
            className={`${inputClass} w-28`}
          />
          <span className="font-mono text-xs text-muted-foreground">MHz</span>
        </Row>

        <Row
          title="ACK timeout"
          command="AT+ACKTMO"
          description={`How long the module waits for an acknowledgement: 10 × (link distance in km − 1). The payload uses ${PAYLOAD_MISSION_DEFAULTS.ACKTMO} (300 km). Sent as ${ackValue}.`}
          applied={applied("ACKTMO") && `${applied("ACKTMO")?.value} at ${formatTime(applied("ACKTMO")!.at)}`}
          outcome={outcome.ACKTMO}
          busy={busy === "ACKTMO"}
          disabled={!ready || busy !== null}
          onApply={() => apply("ACKTMO", String(ackValue))}
          invalid={!ackValid && "Enter the link distance in km"}
        >
          <input
            type="number" min={1} step={1} value={distanceKm} onChange={(e) => setDistanceKm(e.target.value)}
            className={`${inputClass} w-28`}
          />
          <span className="font-mono text-xs text-muted-foreground">km link</span>
        </Row>
      </div>

      {/* Any command, for anything not covered above */}
      <details className="rounded-lg border border-border bg-card p-5">
        <summary className="font-mono text-xs text-muted-foreground uppercase tracking-widest cursor-pointer">
          Advanced — send a command
        </summary>
        <div className="mt-4 space-y-3">
          <p className="font-mono text-xs text-muted-foreground">
            Same command set as the payload firmware. MODE, SSID and PSK define the network: the payload
            is the access point (AP), so the ground module normally stays as STA. In GROUP mode (payload
            sends broadcast, longer range) set MODE to GROUP on both ends.
            RSSI takes a device index or MAC (RSSI=1), JOINGROUP takes address,AID (AID 0 sends no
            heartbeats), SYSDBG takes LMAC,1 / LMAC,0 to start or stop the module's radio dump.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">AT+</span>
            <select
              value={rawName} onChange={(e) => setRawName(e.target.value as GroundAtCommand)}
              className={`${inputClass} w-44`}
            >
              {ALL_COMMANDS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="font-mono text-sm text-muted-foreground">=</span>
            <input
              type={rawName === "PSK" ? "password" : "text"}
              value={rawValue} onChange={(e) => setRawValue(e.target.value)}
              placeholder="value" className={`${inputClass} w-64`}
            />
            <button
              onClick={() => apply(rawName, rawValue, true)}
              disabled={!ready || busy !== null || rawValue.trim() === ""}
              className="px-4 py-2 rounded-lg bg-primary/20 text-primary border border-primary/40 font-mono text-xs font-semibold hover:bg-primary/30 transition-all disabled:opacity-40"
            >
              Send
            </button>
          </div>
          {rawOutcome && (
            <p className={`font-mono text-xs ${rawOutcome.ok ? "text-success" : "text-destructive"}`}>
              AT+{rawOutcome.name}: {rawOutcome.text}
            </p>
          )}
        </div>
      </details>

      {/* What the module answered */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-widest">
          Command history (this session) — also written to mission_events_*.csv
        </h3>
        {status && status.history.length > 0 ? (
          <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
            {[...status.history].reverse().map((entry, i) => (
              <div key={`${entry.sentAt}-${i}`} className="rounded border border-border/60 bg-background p-3 font-mono text-xs">
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground">{formatTime(entry.sentAt)}</span>
                  <span className="text-foreground font-semibold">AT+{entry.name}={entry.value}</span>
                  <span className={entry.ok ? "text-success" : "text-destructive"}>
                    {entry.ok ? "OK" : "FAILED"}
                  </span>
                  {entry.attempts > 1 && (
                    <span className="text-muted-foreground">{entry.attempts} attempts</span>
                  )}
                </div>
                {entry.error && <div className="mt-1 text-destructive">{entry.error}</div>}
                {entry.response.length > 0 && (
                  <div className="mt-1 text-muted-foreground whitespace-pre-wrap">
                    {entry.response.map((line) => `< ${line}`).join("\n")}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="font-mono text-xs text-muted-foreground italic">No commands sent yet.</p>
        )}
      </div>
    </div>
  );
}

function Row({
  title, command, description, applied, outcome, busy, disabled, onApply, warn, invalid, children,
}: {
  title: string;
  command: string;
  description: string;
  applied?: string | undefined | false;
  outcome?: { ok: boolean; text: string };
  busy: boolean;
  disabled: boolean;
  onApply: () => void;
  warn?: boolean;
  /** A message when the current input cannot be sent. */
  invalid?: string | false;
  children: ReactNode;
}) {
  return (
    <div className="p-5 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-center">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm font-semibold text-foreground">{title}</span>
          <span className="font-mono text-xs text-primary/70">{command}</span>
          {warn && <span className="font-mono text-xs text-warning">affects the link</span>}
        </div>
        <p className="font-mono text-xs text-muted-foreground">{description}</p>
        {applied && <p className="font-mono text-xs text-success">Last applied: {applied}</p>}
        {invalid && <p className="font-mono text-xs text-warning">{invalid}</p>}
        {outcome && (
          <p className={`font-mono text-xs ${outcome.ok ? "text-success" : "text-destructive"}`}>{outcome.text}</p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {children}
        <button
          onClick={onApply}
          disabled={disabled || Boolean(invalid)}
          className="px-4 py-2 rounded-lg bg-primary/20 text-primary border border-primary/40 font-mono text-xs font-semibold hover:bg-primary/30 transition-all disabled:opacity-40"
        >
          {busy ? "Sending…" : "Apply"}
        </button>
      </div>
    </div>
  );
}
