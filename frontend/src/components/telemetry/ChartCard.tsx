import type { ReactNode } from "react";
import type { SeriesStats } from "@/lib/telemetrySeries";
import { formatValue } from "./chartTheme";

interface Props {
  title: string;
  /** Unit shown next to the current value and the statistics. */
  unit?: string;
  decimals?: number;
  stats: SeriesStats | null;
  /** Accent for the current value. */
  color: string;
  /** A short tag at the top right (for example where the data comes from). */
  badge?: string;
  /** Legend for charts with more than one series. */
  legend?: { label: string; color: string }[];
  emptyMessage?: string;
  children: ReactNode;
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</span>
      <span className="text-xs font-semibold text-foreground">
        {value}{unit && value !== "—" ? ` ${unit}` : ""}
      </span>
    </div>
  );
}

export default function ChartCard({
  title, unit, decimals = 1, stats, color, badge, legend, emptyMessage = "Waiting for data", children,
}: Props) {
  const f = (v: number | null | undefined) => formatValue(v, decimals);
  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{title}</h3>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-3xl font-semibold leading-none" style={{ color }}>
              {f(stats?.last)}
            </span>
            {unit && stats?.last != null && (
              <span className="font-mono text-sm text-muted-foreground">{unit}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {badge && (
            <span className="rounded-full border border-border/70 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              {badge}
            </span>
          )}
          {stats && (
            <div className="flex gap-4 font-mono">
              <Stat label="min" value={f(stats.min)} unit={unit} />
              <Stat label="avg" value={f(stats.mean)} unit={unit} />
              <Stat label="max" value={f(stats.max)} unit={unit} />
            </div>
          )}
        </div>
      </header>

      {legend && legend.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
          {legend.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3">
        {stats ? (
          children
        ) : (
          <div className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-border/70 font-mono text-xs text-muted-foreground">
            {emptyMessage}
          </div>
        )}
      </div>
    </section>
  );
}
