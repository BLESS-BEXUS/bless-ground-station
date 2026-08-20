export const LINK_FRESHNESS_MS = 5000;

export type TelemetrySource = "elink" | "halow" | "none";

export function selectTelemetrySource(
  now: number,
  lastElinkRx: number,
  lastHalowRx: number,
  hasElink: boolean,
  hasHalow: boolean,
): TelemetrySource {
  if (hasElink && (now - lastElinkRx) <= LINK_FRESHNESS_MS) return "elink";
  if (hasHalow && (now - lastHalowRx) <= LINK_FRESHNESS_MS) return "halow";
  return "none";
}
