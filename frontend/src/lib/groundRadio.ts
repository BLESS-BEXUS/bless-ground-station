// Settings of the ground-station T-HaLow, as AT commands (same ones the payload
// firmware sends to its own module: BLESS-Source-Code, Core/Inc/txhalow.h).

export type GroundAtCommand =
  | "TXPOWER" | "TX_MCS" | "BSS_BW" | "FREQ_RANGE" | "ACKTMO" | "MODE" | "SSID" | "PSK";

/** Mission configuration of the payload module, shown as a reference next to each setting. */
export const PAYLOAD_MISSION_DEFAULTS = {
  TXPOWER: "9",
  TX_MCS: "0",
  BSS_BW: "1",
  FREQ_RANGE: "8660,8670",
  ACKTMO: "2990",
} as const;

export const TX_POWER_RANGE = { min: 6, max: 20 } as const;

export const MCS_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "MCS0 · BPSK 1/2 (most robust)" },
  { value: 1, label: "MCS1 · QPSK 1/2" },
  { value: 2, label: "MCS2 · QPSK 3/4" },
  { value: 3, label: "MCS3 · 16-QAM 1/2" },
  { value: 4, label: "MCS4 · 16-QAM 3/4" },
  { value: 5, label: "MCS5 · 64-QAM 2/3" },
  { value: 6, label: "MCS6 · 64-QAM 3/4" },
  { value: 7, label: "MCS7 · 64-QAM 5/6 (fastest)" },
];

export const BANDWIDTH_OPTIONS = [1, 2, 4, 8] as const;

/** AT+FREQ_RANGE takes two numbers in 100 kHz units: 866.0 / 867.0 MHz -> "8660,8670". */
export function freqRangeValue(startMHz: number, endMHz: number): string {
  return `${Math.round(startMHz * 10)},${Math.round(endMHz * 10)}`;
}

export function parseFreqRange(value: string): { startMHz: number; endMHz: number } | null {
  const match = /^(\d{4}),(\d{4})$/.exec(value.trim());
  if (!match) return null;
  return { startMHz: Number(match[1]) / 10, endMHz: Number(match[2]) / 10 };
}

/** The payload computes the ACK timeout as 10 × (link distance in km − 1). */
export function ackTimeoutFor(distanceKm: number): number {
  return Math.max(0, Math.round(10 * (distanceKm - 1)));
}

export function distanceForAckTimeout(ackTimeout: number): number {
  return ackTimeout / 10 + 1;
}

/** Settings that, if changed on one end only, break the link until both agree. */
export const LINK_BREAKING: readonly GroundAtCommand[] = ["BSS_BW", "FREQ_RANGE", "MODE", "SSID", "PSK"];

export function changeBreaksLink(name: GroundAtCommand): boolean {
  return LINK_BREAKING.includes(name);
}
