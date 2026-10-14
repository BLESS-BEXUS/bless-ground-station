import { useMemo } from "react";
import { flagRuns, type TelemetrySample } from "@/lib/telemetrySeries";
import { CHART_COLORS, formatClock } from "./chartTheme";

/** Bit -> sensor, as the payload firmware defines the error flags (see telemetryErrors.ts). */
const ERROR_BITS: { bit: number; label: string }[] = [
  { bit: 0, label: "Internal temperature" },
  { bit: 1, label: "External temperature" },
  { bit: 2, label: "External humidity" },
  { bit: 4, label: "HaLow current" },
  { bit: 5, label: "Pressure" },
];

interface Props {
  samples: TelemetrySample[];
}

/** One strip per sensor: red where its error flag was set, over the visible time range. */
export default function ErrorStrips({ samples }: Props) {
  const range = useMemo(() => {
    if (samples.length === 0) return null;
    return { from: samples[0].t, to: samples[samples.length - 1].t };
  }, [samples]);

  const runs = useMemo(() => flagRuns(samples, ERROR_BITS.map((b) => b.bit)), [samples]);
  const span = range ? Math.max(range.to - range.from, 1) : 1;

  return (
    <div className="space-y-2">
      {ERROR_BITS.map(({ bit, label }) => {
        const bitRuns = runs.get(bit) ?? [];
        const active = bitRuns.length > 0;
        const last = samples[samples.length - 1];
        const nowSet = last?.errorFlags != null && ((last.errorFlags >> bit) & 1) === 1;
        return (
          <div key={bit} className="grid grid-cols-[150px_1fr_64px] items-center gap-3">
            <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
            <div className="relative h-3 overflow-hidden rounded-full bg-background/70 ring-1 ring-border/60">
              {range && bitRuns.map((r, i) => {
                const left = ((r.from - range.from) / span) * 100;
                const width = Math.max(((r.to - r.from) / span) * 100, 0.8);
                return (
                  <span
                    key={i}
                    className="absolute top-0 h-full rounded-full"
                    style={{ left: `${left}%`, width: `${width}%`, backgroundColor: CHART_COLORS.coral }}
                    title={`${formatClock(r.from)} – ${formatClock(r.to)}`}
                  />
                );
              })}
            </div>
            <span
              className="text-right font-mono text-[11px] font-semibold"
              style={{ color: nowSet ? CHART_COLORS.coral : active ? CHART_COLORS.amber : CHART_COLORS.green }}
            >
              {nowSet ? "FAULT" : active ? "past" : "OK"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
