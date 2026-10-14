import { useId, useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CHART_AXIS,
  CHART_CURSOR,
  CHART_GRID,
  formatClock,
  formatValue,
  paddedDomain,
  tickDecimals,
} from "./chartTheme";

export interface ChartRow {
  t: number;
  [key: string]: number | null;
}

export interface SeriesSpec {
  key: string;
  label: string;
  color: string;
  unit?: string;
  decimals?: number;
  /** area: filled; line: plain; step: filled, holds the value until the next sample. */
  kind?: "area" | "line" | "step";
  dashed?: boolean;
}

export interface ReferenceSpec {
  y: number;
  label: string;
  color?: string;
}

interface Props {
  data: ChartRow[];
  series: SeriesSpec[];
  height?: number;
  /** Override the automatic y range. */
  yDomain?: [number, number];
  references?: ReferenceSpec[];
  /** Charts with the same id share their cursor and tooltip position. */
  syncId?: string;
  connectNulls?: boolean;
}

function ChartTooltip({
  active, payload, label, series,
}: {
  active?: boolean;
  payload?: { dataKey?: string; value?: number | null }[];
  label?: number;
  series: SeriesSpec[];
}) {
  if (!active || !payload || payload.length === 0 || typeof label !== "number") return null;
  const rows = series
    .map((s) => ({ spec: s, value: payload.find((p) => p.dataKey === s.key)?.value ?? null }))
    .filter((r) => r.value !== null);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-md border border-border/70 bg-card/95 px-3 py-2 shadow-xl backdrop-blur font-mono text-xs">
      <div className="mb-1 text-muted-foreground">{formatClock(label)}</div>
      {rows.map(({ spec, value }) => (
        <div key={spec.key} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: spec.color }} />
          <span className="text-muted-foreground">{spec.label}</span>
          <span className="ml-auto pl-4 font-semibold text-foreground">
            {formatValue(value, spec.decimals ?? 1)}{spec.unit ? ` ${spec.unit}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function TimeSeriesChart({
  data, series, height = 180, yDomain, references = [], syncId, connectNulls = true,
}: Props) {
  const uid = useId().replace(/:/g, "");

  const domain = useMemo<[number, number]>(() => {
    if (yDomain) return yDomain;
    const values: number[] = [];
    for (const row of data) {
      for (const s of series) {
        const v = row[s.key];
        if (typeof v === "number" && Number.isFinite(v)) values.push(v);
      }
    }
    return paddedDomain(values, references.map((r) => r.y));
  }, [data, series, references, yDomain]);

  const decimals = tickDecimals(domain);
  const spanMs = data.length > 1 ? data[data.length - 1].t - data[0].t : 0;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} syncId={syncId} syncMethod="value">
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.42} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={CHART_GRID} vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={["dataMin", "dataMax"]}
          tickFormatter={(t: number) => formatClock(t, spanMs < 2 * 3600_000)}
          tick={{ fill: CHART_AXIS, fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
          tickLine={false}
          axisLine={{ stroke: CHART_GRID }}
          minTickGap={48}
        />
        <YAxis
          domain={domain}
          tickFormatter={(v: number) => formatValue(v, decimals)}
          tick={{ fill: CHART_AXIS, fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
          tickLine={false}
          axisLine={false}
          width={46}
        />
        {references.map((r) => (
          <ReferenceLine
            key={`${r.y}-${r.label}`}
            y={r.y}
            stroke={r.color ?? CHART_AXIS}
            strokeDasharray="4 4"
            strokeOpacity={0.7}
            label={{ value: r.label, position: "insideTopRight", fill: r.color ?? CHART_AXIS, fontSize: 10 }}
          />
        ))}
        <Tooltip
          content={<ChartTooltip series={series} />}
          cursor={{ stroke: CHART_CURSOR, strokeDasharray: "3 3" }}
          isAnimationActive={false}
        />
        {series.map((s) =>
          s.kind === "line" ? (
            <Line
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? "5 4" : undefined}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0, fill: s.color }}
              connectNulls={connectNulls}
              isAnimationActive={false}
            />
          ) : (
            <Area
              key={s.key}
              dataKey={s.key}
              type={s.kind === "step" ? "stepAfter" : "monotone"}
              stroke={s.color}
              strokeWidth={2}
              fill={`url(#${uid}-${s.key})`}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0, fill: s.color }}
              connectNulls={connectNulls}
              isAnimationActive={false}
            />
          ),
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
