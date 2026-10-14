import { beforeEach, describe, expect, it } from "vitest";
import {
  calibrate,
  calibrationIsStale,
  loadTripodCalibration,
  normalizeAzimuth,
  parseTripodCalibration,
  saveTripodCalibration,
  toTripodAzimuth,
  toTripodElevation,
} from "@/lib/tripodCalibration";

describe("tripod azimuth calibration (numbers drop when turning right)", () => {
  // The real case: pointing at the payload the tripod reads 335 while the software computes 40.1
  const cal = calibrate({ computedAz: 40.1, computedEl: -6.7, tripodAz: 335, tripodEl: -6.7, clockwise: false });

  it("shows the tripod's own reading at the calibration point", () => {
    expect(toTripodAzimuth(40.1, cal)).toBeCloseTo(335, 6);
  });

  it("reproduces the marks seen on the tripod: 305 thirty degrees to the right, 0 to the left", () => {
    // turning right = the true bearing grows
    expect(toTripodAzimuth(40.1 + 30, cal)).toBeCloseTo(305, 6);
    expect(toTripodAzimuth(40.1 + 5, cal)).toBeCloseTo(330, 6);
    // turning left = the true bearing shrinks; the scale passes through 0 / 360
    expect(toTripodAzimuth(40.1 - 25, cal)).toBeCloseTo(0, 6);
    expect(toTripodAzimuth(40.1 - 30, cal)).toBeCloseTo(5, 6);
  });

  it("always answers within 0-360", () => {
    for (let computed = 0; computed < 360; computed += 7.3) {
      const shown = toTripodAzimuth(computed, cal);
      expect(shown).toBeGreaterThanOrEqual(0);
      expect(shown).toBeLessThan(360);
    }
  });

  it("is a rigid shift: equal true angles give equal tripod angles, in the opposite sense", () => {
    const a = toTripodAzimuth(100, cal);
    const b = toTripodAzimuth(110, cal);
    expect(normalizeAzimuth(a - b)).toBeCloseTo(10, 6);
  });
});

describe("tripod azimuth calibration (numbers grow when turning right)", () => {
  const cal = calibrate({ computedAz: 40.1, computedEl: 0, tripodAz: 335, tripodEl: 0, clockwise: true });

  it("keeps the same sense as the true bearing", () => {
    expect(toTripodAzimuth(40.1, cal)).toBeCloseTo(335, 6);
    expect(toTripodAzimuth(40.1 + 30, cal)).toBeCloseTo(5, 6);       // 335 + 30 wraps past 360
    expect(toTripodAzimuth(40.1 - 30, cal)).toBeCloseTo(305, 6);
  });
});

describe("elevation", () => {
  it("is left exactly as computed when no tripod elevation is given", () => {
    const cal = calibrate({ computedAz: 40.1, computedEl: -6.7, tripodAz: 335, tripodEl: -6.7, clockwise: false });
    expect(cal.elOffset).toBe(0);
    expect(toTripodElevation(-6.7, cal)).toBe(-6.7);
    expect(toTripodElevation(12.3, cal)).toBe(12.3);
  });

  it("can still be offset when the tripod zero is somewhere else", () => {
    const cal = calibrate({ computedAz: 40.1, computedEl: -6.7, tripodAz: 335, tripodEl: 0 });
    expect(toTripodElevation(-6.7, cal)).toBeCloseTo(0, 9);
    expect(toTripodElevation(3.3, cal)).toBeCloseTo(10, 9);
  });

  it("changes nothing when there is no calibration", () => {
    expect(toTripodAzimuth(40.1, null)).toBe(40.1);
    expect(toTripodElevation(-6.7, null)).toBe(-6.7);
  });
});

describe("saved calibration", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips through the browser storage", () => {
    const cal = calibrate({ computedAz: 40.1, computedEl: -6.7, tripodAz: 335, tripodEl: -6.7, clockwise: false });
    saveTripodCalibration(cal);
    expect(loadTripodCalibration()).toEqual(cal);
    saveTripodCalibration(null);
    expect(loadTripodCalibration()).toBeNull();
  });

  it("ignores corrupt or incomplete data instead of applying a bad offset", () => {
    expect(parseTripodCalibration(null)).toBeNull();
    expect(parseTripodCalibration("{not json")).toBeNull();
    expect(parseTripodCalibration(JSON.stringify({ azOffset: "x", elOffset: 0, clockwise: true }))).toBeNull();
    expect(parseTripodCalibration(JSON.stringify({ azOffset: 10, elOffset: 0 }))).toBeNull();
    expect(parseTripodCalibration(JSON.stringify({ azOffset: Number.NaN, elOffset: 0, clockwise: true }))).toBeNull();
  });
});

describe("a calibration made with other station coordinates", () => {
  const station = { lat: 67.8856, lng: 21.0786, alt: 310 };
  const cal = calibrate({
    computedAz: 40.1, computedEl: 0, tripodAz: 335, tripodEl: 0, clockwise: false, groundStation: station,
  });

  it("is current while the coordinates are the ones it was made with", () => {
    expect(calibrationIsStale(cal, station)).toBe(false);
    expect(calibrationIsStale(cal, { ...station, lat: station.lat + 1e-9 })).toBe(false);   // float noise
  });

  it("goes stale when the station is moved or re-surveyed", () => {
    expect(calibrationIsStale(cal, { ...station, lat: 67.87964 })).toBe(true);
    expect(calibrationIsStale(cal, { ...station, lng: 21.062234 })).toBe(true);
    expect(calibrationIsStale(cal, { ...station, alt: 484 })).toBe(true);
  });

  it("cannot tell for a calibration saved before the position was recorded, nor without one", () => {
    expect(calibrationIsStale({ ...cal, groundStation: undefined }, { ...station, lat: 1 })).toBe(false);
    expect(calibrationIsStale(null, station)).toBe(false);
  });

  it("keeps the station position through the browser storage", () => {
    saveTripodCalibration(cal);
    expect(loadTripodCalibration()?.groundStation).toEqual(station);
    window.localStorage.clear();
  });
});
