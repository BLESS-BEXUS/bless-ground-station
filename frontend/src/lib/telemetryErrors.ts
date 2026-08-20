const ERROR_LABELS: Record<number, string> = {
  0: "TEMP_INT",
  1: "TEMP_EXT",
  2: "HUM_EXT",
  4: "I_HALOW",
  5: "PRESSURE",
};

export function decodeTelemetryErrors(flags: number): string | null {
  if (flags === 0) return null;
  return Array.from({ length: 8 }, (_, bit) => ((flags >> bit) & 1)
    ? (ERROR_LABELS[bit] ?? `ERR[${bit}]`)
    : null)
    .filter(Boolean)
    .join(" · ");
}
