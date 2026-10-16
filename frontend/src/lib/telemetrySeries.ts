import { groundRadio, payloadRadio } from "./radio";

// ─── Samples ──────────────────────────────────────────────────────────────────

/** One E-Link packet, flattened for plotting. Times are the ground station's clock. */
export interface TelemetrySample {
  t: number;
  /** Payload packet counter and its own millisecond clock. */
  count: number | null;
  uptimeMs: number | null;
  lat: number | null;
  lng: number | null;
  alt: number | null;
  sats: number | null;
  fix: boolean | null;
  /** What the payload measured of the ground station's frames (null when it has no reading). */
  rssi: number | null;
  snr: number | null;
  noiseFloor: number | null;
  freqDevHz: number | null;
  /** What the ground station's module measured of the payload's frames. Never mixed with the above. */
  gsRssi: number | null;
  gsSnr: number | null;
  gsNoiseFloor: number | null;
  gsFreqDev: number | null;
  pdr: number | null;
  mcs: number | null;
  gsMcs: number | null;
  gsPer: number | null;
  state: number | null;
  halowCurrMa: number | null;
  chipTempC: number | null;
  heaterPower: number | null;
  pressurePa: number | null;
  extTempC: number | null;
  intTempC: number | null;
  humidity: number | null;
  radiationCps: number | null;
  errorFlags: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A packet as the backend sends it (JSON) -> a plotting sample. */
export function sampleFromPacket(raw: unknown, fallbackTime = Date.now()): TelemetrySample | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const parsedTime = typeof p.receivedAt === "string" ? Date.parse(p.receivedAt) : NaN;
  const payload = payloadRadio({
    rssi: num(p.rssi), snr: num(p.snr), noiseFloor: num(p.noiseFloor), freqDevHz: num(p.freqDevHz),
  });
  const ground = groundRadio({
    gsRssi: num(p.gsRssi), gsSnr: num(p.gsSnr), gsNoiseFloor: num(p.gsNoiseFloor), gsFreqDev: num(p.gsFreqDev),
  });
  return {
    t: Number.isFinite(parsedTime) ? parsedTime : fallbackTime,
    count: num(p.packetCount),
    uptimeMs: num(p.timestamp),
    lat: num(p.latitude),
    lng: num(p.longitude),
    alt: num(p.altitude),
    sats: num(p.gpsSats),
    fix: typeof p.gpsFix === "boolean" ? p.gpsFix : null,
    rssi: payload.rssi,
    snr: payload.snr,
    noiseFloor: payload.noiseFloor,
    freqDevHz: payload.freqDevHz,
    gsRssi: ground.rssi,
    gsSnr: ground.snr,
    gsNoiseFloor: ground.noiseFloor,
    gsFreqDev: ground.freqDevHz,
    pdr: num(p.successRate),
    mcs: num(p.txMcs),
    gsMcs: num(p.gsMcs),
    gsPer: num(p.gsPer),
    state: num(p.systemState),
    halowCurrMa: num(p.halowCurrMa),
    chipTempC: num(p.chipTempC),
    heaterPower: num(p.heaterPower),
    pressurePa: num(p.pressurePa),
    extTempC: num(p.extTempC),
    intTempC: num(p.intTempC),
    humidity: num(p.extHumidityRh),
    radiationCps: num(p.radiationCps),
    errorFlags: num(p.errorFlags),
  };
}

/** One "LMAC STATUS" dump of the ground-station HaLow module (see the backend's gsLmac.ts). */
export interface GsRfView {
  t: number;
  rssi: number | null;
  snr: number | null;
  noiseFloor: number | null;
  background: number | null;
  freqMHz: number | null;
  bwMHz: number | null;
  rxFrames: number | null;
  rxKbps: number | null;
  txPerPct: number | null;
  txMcs: number | null;
  chipTempC: number | null;
  vcc: number | null;
}

export function gsRfFromSnapshot(raw: unknown): GsRfView | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const t = num(s.t);
  if (t === null) return null;
  return {
    t,
    rssi: num(s.rssi), snr: num(s.snr), noiseFloor: num(s.noiseFloor), background: num(s.background),
    freqMHz: num(s.freqMHz), bwMHz: num(s.bwMHz), rxFrames: num(s.rxFrames), rxKbps: num(s.rxKbps),
    txPerPct: num(s.txPerPct), txMcs: num(s.txMcs), chipTempC: num(s.chipTempC), vcc: num(s.vcc),
  };
}

// ─── Windows and decimation ───────────────────────────────────────────────────

/** Keep the items of the last `windowMs`, counted back from the newest one (null = all). */
export function windowed<T extends { t: number }>(items: T[], windowMs: number | null): T[] {
  if (windowMs === null || items.length === 0) return items;
  const newest = items[items.length - 1].t;
  const from = newest - windowMs;
  let start = 0;
  while (start < items.length && items[start].t < from) start++;
  return start === 0 ? items : items.slice(start);
}

/** At most `maxPoints`, evenly spaced, always keeping the first and the newest point. */
export function downsample<T>(items: T[], maxPoints = 900): T[] {
  if (items.length <= maxPoints || maxPoints < 2) return items;
  const out: T[] = [];
  const step = (items.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out.push(items[Math.round(i * step)]);
  return out;
}

// ─── Derived quantities ───────────────────────────────────────────────────────

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Vertical speed in m/s, from the altitude `lag` samples back: smoother than
 * differencing consecutive GNSS fixes. Aligned with `samples`; null where unknown.
 */
export function verticalSpeed(samples: TelemetrySample[], lag = 3): (number | null)[] {
  return samples.map((s, i) => {
    const prev = samples[i - lag];
    if (!prev || s.alt === null || prev.alt === null) return null;
    const seconds = (s.t - prev.t) / 1000;
    return seconds > 0 ? (s.alt - prev.alt) / seconds : null;
  });
}

/** Ground speed in km/h, from the GNSS position `lag` samples back. */
export function groundSpeedKmh(samples: TelemetrySample[], lag = 3): (number | null)[] {
  return samples.map((s, i) => {
    const prev = samples[i - lag];
    if (!prev || s.lat === null || s.lng === null || prev.lat === null || prev.lng === null) return null;
    if (s.fix === false || prev.fix === false) return null;
    const seconds = (s.t - prev.t) / 1000;
    if (seconds <= 0) return null;
    return (haversineM(prev.lat, prev.lng, s.lat, s.lng) / seconds) * 3.6;
  });
}

/** Seconds between consecutive packets, aligned with `samples` (null for the first). */
export function packetIntervals(samples: TelemetrySample[]): (number | null)[] {
  return samples.map((s, i) => (i === 0 ? null : (s.t - samples[i - 1].t) / 1000));
}

export interface SeriesStats {
  min: number;
  max: number;
  mean: number;
  last: number | null;
  count: number;
}

export function seriesStats(values: (number | null | undefined)[]): SeriesStats | null {
  const real = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (real.length === 0) return null;
  const last = [...values].reverse().find((v): v is number => typeof v === "number" && Number.isFinite(v)) ?? null;
  return {
    min: Math.min(...real),
    max: Math.max(...real),
    mean: real.reduce((a, b) => a + b, 0) / real.length,
    last,
    count: real.length,
  };
}

// ─── Radio series: one per provider, never merged ─────────────────────────────

export interface RadioPoint {
  t: number;
  rssi: number | null;
  snr: number | null;
  noiseFloor: number | null;
  freqDevHz: number | null;
}

/**
 * What the payload measured, one point per E-Link packet that carried a reading. Points
 * the payload sent as 0 are left out: nothing from the ground station fills them in.
 */
export function buildPayloadRadioSeries(samples: TelemetrySample[]): RadioPoint[] {
  const points: RadioPoint[] = [];
  for (const s of samples) {
    if (s.rssi === null && s.snr === null && s.noiseFloor === null && s.freqDevHz === null) continue;
    points.push({ t: s.t, rssi: s.rssi, snr: s.snr, noiseFloor: s.noiseFloor, freqDevHz: s.freqDevHz });
  }
  return points;
}

/**
 * What the ground station's module measured: RSSI, SNR and noise floor from its own status
 * dumps, and the frequency deviation it reports with the packets. Idle dumps (no RSSI) are
 * not points. Sorted by time.
 */
export function buildGroundRadioSeries(samples: TelemetrySample[], dumps: GsRfView[]): RadioPoint[] {
  const points: RadioPoint[] = [];
  for (const d of dumps) {
    if (d.rssi === null) continue;
    points.push({ t: d.t, rssi: d.rssi, snr: d.snr, noiseFloor: d.noiseFloor, freqDevHz: null });
  }
  for (const s of samples) {
    if (s.gsFreqDev === null) continue;
    points.push({ t: s.t, rssi: null, snr: null, noiseFloor: null, freqDevHz: s.gsFreqDev });
  }
  return points.sort((a, b) => a.t - b.t);
}

// ─── Error flags ──────────────────────────────────────────────────────────────

export interface FlagRun {
  from: number;
  to: number;
}

/**
 * For each bit of the error flags, the stretches of time it was set. A run ends at
 * the last sample that still had the bit, extended to the next sample's time.
 */
export function flagRuns(samples: TelemetrySample[], bits: number[]): Map<number, FlagRun[]> {
  const result = new Map<number, FlagRun[]>();
  for (const bit of bits) {
    const runs: FlagRun[] = [];
    let open: FlagRun | null = null;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const set = s.errorFlags !== null && ((s.errorFlags >> bit) & 1) === 1;
      if (set) {
        const end = samples[i + 1]?.t ?? s.t;
        if (open) open.to = end;
        else { open = { from: s.t, to: end }; runs.push(open); }
      } else {
        open = null;
      }
    }
    result.set(bit, runs);
  }
  return result;
}
