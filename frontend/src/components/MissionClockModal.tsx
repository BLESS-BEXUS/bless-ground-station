import { useState } from "react";
import type { useMissionClock } from "@/hooks/useMissionClock";
import { formatMissionTime, parseClockInput } from "@/lib/missionClock";

interface Props {
  open: boolean;
  onClose: () => void;
  clock: ReturnType<typeof useMissionClock>;
  /** Payload uptime (HH:MM:SS) when telemetry is flowing, shown for reference only. */
  payloadUptime: string | null;
}

const PRESETS: { label: string; sign: "-" | "+"; value: string }[] = [
  { label: "T-04:00:00", sign: "-", value: "04:00:00" },
  { label: "T-01:00:00", sign: "-", value: "01:00:00" },
  { label: "T-00:10:00", sign: "-", value: "00:10:00" },
  { label: "T+00:00:00", sign: "+", value: "00:00:00" },
];

const NUDGES = [-10, -1, 1, 10];

export default function MissionClockModal({ open, onClose, clock, payloadUptime }: Props) {
  const [sign, setSign] = useState<"-" | "+">("-");
  const [value, setValue] = useState("04:00:00");
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  function submit() {
    const seconds = parseClockInput(value);
    if (seconds === null) {
      setError("Use HH:MM:SS (e.g. 04:00:00)");
      return;
    }
    setError(null);
    clock.start(sign === "-" ? -seconds : seconds);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-card border border-border rounded-xl w-full max-w-md p-6 space-y-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-sm font-bold text-primary uppercase tracking-widest">
            Mission Clock
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground font-mono text-lg leading-none">
            ✕
          </button>
        </div>

        {/* Current status */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
          <div className={`h-2 w-2 rounded-full ${clock.running ? "bg-success animate-pulse" : "bg-muted-foreground/40"}`} />
          <span className="font-mono text-xs text-muted-foreground">Clock:</span>
          <span className="font-mono text-sm font-semibold text-foreground">
            {clock.offsetMs === null ? "NOT STARTED" : formatMissionTime(clock.offsetMs)}
          </span>
          {payloadUptime && (
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              payload uptime {payloadUptime}
            </span>
          )}
        </div>

        {/* Set + start */}
        <div className="space-y-2">
          <label className="font-mono text-xs text-muted-foreground uppercase tracking-wider">
            Start clock at
          </label>
          <div className="flex gap-2">
            <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
              {(["-", "+"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSign(s)}
                  className={`px-3 py-2 font-mono text-sm font-semibold transition-all ${
                    sign === s
                      ? "bg-primary/20 text-primary"
                      : "bg-background text-muted-foreground hover:bg-muted/30"
                  }`}
                >
                  T{s}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="HH:MM:SS"
              className="w-full bg-background border border-border rounded-lg px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary/60"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => { setSign(p.sign); setValue(p.value); setError(null); }}
                className="px-2.5 py-1 rounded-md border border-border font-mono text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-all"
              >
                {p.label}
              </button>
            ))}
          </div>
          {error && <p className="font-mono text-xs text-destructive">{error}</p>}
        </div>

        {/* Fine sync */}
        {clock.running && (
          <div className="space-y-2">
            <label className="font-mono text-xs text-muted-foreground uppercase tracking-wider">
              Fine sync (shifts the displayed time)
            </label>
            <div className="grid grid-cols-4 gap-2">
              {NUDGES.map((d) => (
                <button
                  key={d}
                  onClick={() => clock.adjust(d)}
                  className="px-2 py-1.5 rounded-lg border border-border font-mono text-xs text-foreground hover:bg-muted/30 transition-all"
                >
                  {d > 0 ? `+${d} s` : `${d} s`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          {clock.running && (
            <button
              onClick={() => { clock.stop(); onClose(); }}
              className="flex-1 px-4 py-2 rounded-lg border border-destructive/40 font-mono text-xs text-destructive hover:bg-destructive/10 transition-all"
            >
              Stop / reset
            </button>
          )}
          <button
            onClick={submit}
            className="flex-1 px-4 py-2 rounded-lg bg-primary/20 text-primary border border-primary/40 font-mono text-xs font-semibold hover:bg-primary/30 transition-all"
          >
            {clock.running ? "Restart" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
