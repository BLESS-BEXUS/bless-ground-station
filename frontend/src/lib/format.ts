import type { LinkMode } from "@/hooks/useLiveData";

export const NO_DATA = "—";

export const LINK_MODE_LABEL: Record<LinkMode, string> = {
  none: "NO DATA",
  elink: "E-LINK",
  halow: "HALOW",
  "halow+elink": "HALOW + E-LINK",
};

export function fmt(value: number | null | undefined, decimals = 2, unit = ""): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_DATA;
  const text = Math.abs(value) > 9999 ? value.toFixed(0) : value.toFixed(decimals);
  return unit ? `${text} ${unit}` : text;
}
