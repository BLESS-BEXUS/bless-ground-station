/** One palette for every chart: distinct on the dark navy cards and readable together. */
export const CHART_COLORS = {
  blue: "#5BB5F0",
  teal: "#4FD1B5",
  amber: "#F2B84B",
  coral: "#EF6F6C",
  violet: "#B49BEA",
  green: "#A5CF6B",
  sky: "#8FD3F4",
  rose: "#F28DB2",
} as const;

export const CHART_GRID = "rgba(190, 205, 235, 0.10)";
export const CHART_AXIS = "rgba(214, 222, 240, 0.55)";
export const CHART_CURSOR = "rgba(214, 222, 240, 0.35)";

/** HH:MM:SS (or HH:MM across long spans) in the browser's clock. */
export function formatClock(t: number, withSeconds = true): string {
  return new Date(t).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

/** Round to `decimals`, drop a trailing -0. */
export function formatValue(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const text = value.toFixed(decimals);
  return text === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : text;
}

/** A y range that fits the data (and any reference lines) with some air around it. */
export function paddedDomain(
  values: number[],
  references: number[] = [],
  include: number[] = [],
): [number, number] {
  const all = [...values, ...references, ...include].filter((v) => Number.isFinite(v));
  if (all.length === 0) return [0, 1];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.05, 1);
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.1;
  min -= pad;
  max += pad;
  return [min, max];
}

/** Ticks with sensible decimals for the span they cover. */
export function tickDecimals(domain: [number, number]): number {
  const span = Math.abs(domain[1] - domain[0]);
  if (span < 2) return 2;
  if (span < 20) return 1;
  return 0;
}
