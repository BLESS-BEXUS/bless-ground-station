/**
 * One-point calibration of the antenna tripod.
 *
 * The software computes the true bearing and elevation to the payload. The
 * tripod has its own scales (its azimuth ring is not aligned with true north and
 * its elevation zero was set by eye). Pointing at the payload and typing what the
 * tripod reads fixes two constant offsets, applied to everything shown afterwards,
 * so the operator can type the displayed numbers straight into the tripod.
 */

export const TRIPOD_CALIBRATION_STORAGE_KEY = "bless-tripod-calibration";

export interface TripodCalibration {
  /** Clockwise scale: tripod = computed + offset. Counter-clockwise: tripod = offset − computed. */
  azOffset: number;
  /** tripod = computed + offset */
  elOffset: number;
  /** Does the tripod's azimuth number grow when turning clockwise, like a compass? */
  clockwise: boolean;
  /** What the operator typed, and what the software computed at that moment (for reference). */
  tripodAz: number;
  tripodEl: number;
  computedAz: number;
  computedEl: number;
  /** ISO time of the calibration. */
  at: string;
  /**
   * The ground-station coordinates the computed bearing was based on. If they change
   * afterwards every true bearing shifts and this offset no longer applies.
   */
  groundStation?: StationPosition;
}

export interface StationPosition {
  lat: number;
  lng: number;
  alt: number;
}

export function normalizeAzimuth(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function calibrate(input: {
  computedAz: number;
  computedEl: number;
  tripodAz: number;
  tripodEl: number;
  clockwise?: boolean;
  at?: string;
  groundStation?: StationPosition;
}): TripodCalibration {
  const clockwise = input.clockwise ?? true;
  return {
    azOffset: clockwise ? input.tripodAz - input.computedAz : input.tripodAz + input.computedAz,
    elOffset: input.tripodEl - input.computedEl,
    clockwise,
    tripodAz: input.tripodAz,
    tripodEl: input.tripodEl,
    computedAz: input.computedAz,
    computedEl: input.computedEl,
    at: input.at ?? new Date().toISOString(),
    groundStation: input.groundStation,
  };
}

// About 0.1 m in latitude/longitude and half a metre in altitude: anything the operator
// would type on purpose is bigger than this, float noise is not.
const COORDINATE_TOLERANCE_DEG = 1e-6;
const ALTITUDE_TOLERANCE_M = 0.5;

/** True when the station was moved or re-surveyed after this calibration was made. */
export function calibrationIsStale(
  calibration: TripodCalibration | null,
  station: StationPosition,
): boolean {
  const reference = calibration?.groundStation;
  if (!reference) return false;       // saved before the position was recorded: cannot tell
  return Math.abs(reference.lat - station.lat) > COORDINATE_TOLERANCE_DEG
    || Math.abs(reference.lng - station.lng) > COORDINATE_TOLERANCE_DEG
    || Math.abs(reference.alt - station.alt) > ALTITUDE_TOLERANCE_M;
}

/** The azimuth to dial on the tripod; the computed true bearing when not calibrated. */
export function toTripodAzimuth(computedAz: number, calibration: TripodCalibration | null): number {
  if (!calibration) return computedAz;
  return normalizeAzimuth(
    calibration.clockwise ? computedAz + calibration.azOffset : calibration.azOffset - computedAz,
  );
}

/** The elevation to dial on the tripod; the computed elevation when not calibrated. */
export function toTripodElevation(computedEl: number, calibration: TripodCalibration | null): number {
  return calibration ? computedEl + calibration.elOffset : computedEl;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseTripodCalibration(raw: string | null): TripodCalibration | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<TripodCalibration> | null;
    if (!p || typeof p !== "object") return null;
    if (!finite(p.azOffset) || !finite(p.elOffset) || typeof p.clockwise !== "boolean") return null;
    const gs = p.groundStation;
    const groundStation = gs && finite(gs.lat) && finite(gs.lng) && finite(gs.alt)
      ? { lat: gs.lat, lng: gs.lng, alt: gs.alt }
      : undefined;
    return {
      azOffset: p.azOffset,
      elOffset: p.elOffset,
      clockwise: p.clockwise,
      groundStation,
      tripodAz: finite(p.tripodAz) ? p.tripodAz : 0,
      tripodEl: finite(p.tripodEl) ? p.tripodEl : 0,
      computedAz: finite(p.computedAz) ? p.computedAz : 0,
      computedEl: finite(p.computedEl) ? p.computedEl : 0,
      at: typeof p.at === "string" ? p.at : "",
    };
  } catch {
    return null;
  }
}

export function loadTripodCalibration(): TripodCalibration | null {
  try {
    return parseTripodCalibration(window.localStorage.getItem(TRIPOD_CALIBRATION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveTripodCalibration(calibration: TripodCalibration | null): void {
  try {
    if (calibration) {
      window.localStorage.setItem(TRIPOD_CALIBRATION_STORAGE_KEY, JSON.stringify(calibration));
    } else {
      window.localStorage.removeItem(TRIPOD_CALIBRATION_STORAGE_KEY);
    }
  } catch {
    // storage unavailable: the calibration still applies for this page load
  }
}
