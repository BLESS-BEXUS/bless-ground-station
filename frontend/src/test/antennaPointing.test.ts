import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { computePointingLTC } from "@/pages/AntennaPage";
import { calibrate, normalizeAzimuth, toTripodAzimuth, toTripodElevation } from "@/lib/tripodCalibration";

/**
 * Antenna pointing: the payload flies a circle around the ground station while the
 * software computes where to aim, in the tripod's own scale.
 *
 * Reference: with the payload still at the Dome the tripod was pointing exactly at
 * 335.0° azimuth, -5.6° elevation. That single reading calibrates the tripod, and every
 * number after it is what the operator would dial.
 */

const GS = { lat: 67.87964, lng: 21.062234, alt: 484 };
const DOME = { lat: 67.8907904, lng: 21.080272, alt: 342 };   // median GNSS fix of the payload at the Dome
const TRIPOD_AT_DOME = { az: 335, el: -5.6 };

const RADIUS_M = 1500;
const ALTITUDES_M = [420, 700, 1000, 1500, 2000, 2500, 2000, 1500, 1000, 700];

const EARTH_R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Independent check: spherical forward / inverse problem, no ECEF. */
function destination(lat: number, lng: number, bearingDeg: number, distM: number) {
  const d = distM / EARTH_R;
  const b = rad(bearingDeg);
  const p1 = rad(lat);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = rad(lng) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lng: deg(l2) };
}

function bearing(lat1: number, lng1: number, lat2: number, lng2: number) {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dl = rad(lng2 - lng1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizeAzimuth(deg(Math.atan2(y, x)));
}

function angularDiff(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

const at = (p: { lat: number; lng: number; alt: number }) =>
  computePointingLTC(GS.lat, GS.lng, GS.alt, p.lat, p.lng, p.alt);

const domeTrue = at(DOME);
const calibration = calibrate({
  computedAz: domeTrue.azimuth,
  computedEl: domeTrue.elevation,
  tripodAz: TRIPOD_AT_DOME.az,
  tripodEl: TRIPOD_AT_DOME.el,
  // This tripod's azimuth ring runs counter-clockwise: 360 is to the left, 300 to the right,
  // so the number falls as the antenna turns clockwise (to the right).
  clockwise: false,
  groundStation: GS,
});

/** 10 points of the circle, the first one in the direction of the Dome. */
const circle = ALTITUDES_M.map((alt, i) => {
  const trueBearing = normalizeAzimuth(domeTrue.azimuth + i * 36);
  const pos = destination(GS.lat, GS.lng, trueBearing, RADIUS_M);
  const p = at({ ...pos, alt });
  return {
    n: i + 1,
    lat: pos.lat, lng: pos.lng, alt,
    trueBearing,
    computedAz: p.azimuth, computedEl: p.elevation, slantKm: p.slantRangeKm,
    tripodAz: toTripodAzimuth(p.azimuth, calibration),
    tripodEl: toTripodElevation(p.elevation, calibration),
  };
});

describe("antenna pointing around the ground station", () => {
  it("the Dome reads exactly 335.0° / -5.6° on the tripod after the one-point calibration", () => {
    expect(toTripodAzimuth(domeTrue.azimuth, calibration)).toBeCloseTo(335, 6);
    expect(toTripodElevation(domeTrue.elevation, calibration)).toBeCloseTo(-5.6, 6);
  });

  it("the Dome is where the geometry says: north-east of the station, below it", () => {
    expect(domeTrue.azimuth).toBeGreaterThan(20);
    expect(domeTrue.azimuth).toBeLessThan(45);
    expect(domeTrue.elevation).toBeLessThan(0);                  // station is on higher ground
    expect(domeTrue.slantRangeKm).toBeGreaterThan(1);
    expect(domeTrue.slantRangeKm).toBeLessThan(2);
  });

  it("computes the true bearing of each circle point like an independent spherical solution", () => {
    for (const p of circle) {
      const expected = bearing(GS.lat, GS.lng, p.lat, p.lng);
      expect(angularDiff(p.computedAz, expected)).toBeLessThan(0.05);   // LTC and great circle differ by ~0.01° here
      expect(angularDiff(p.computedAz, p.trueBearing)).toBeLessThan(0.05);
    }
  });

  it("the tripod scale runs counter-clockwise: tripod = offset - true azimuth", () => {
    expect(calibration.clockwise).toBe(false);
    const offset = calibration.azOffset;
    for (const p of circle) {
      expect(angularDiff(p.tripodAz, normalizeAzimuth(offset - p.computedAz))).toBeLessThan(1e-9);
    }
    // the payload moves 36 degrees clockwise each step; the tripod number FALLS by 36
    for (let i = 1; i < circle.length; i++) {
      const fall = normalizeAzimuth(circle[i - 1].tripodAz - circle[i].tripodAz);
      expect(fall).toBeCloseTo(36, 1);
    }
    // to the right of the Dome the number is smaller (335 -> 299), to the left it is larger
    expect(circle[1].tripodAz).toBeCloseTo(299, 0);
    const slightlyLeft = toTripodAzimuth(domeTrue.azimuth - 10, calibration);
    expect(slightlyLeft).toBeCloseTo(345, 0);
    // the 360 mark is to the left of the Dome and 300 to the right, as on the tripod
    const rightOfDome = (az: number) => normalizeAzimuth(az - domeTrue.azimuth) < 180;
    const trueAt = (tripod: number) => normalizeAzimuth(calibration.azOffset - tripod);
    expect(rightOfDome(trueAt(300))).toBe(true);
    expect(rightOfDome(trueAt(360))).toBe(false);
    // a full turn is a full turn: the first point is the Dome direction, 335° on the tripod
    expect(circle[0].tripodAz).toBeCloseTo(335, 1);
  });

  it("elevation rises with the payload's altitude and falls again as it descends", () => {
    const el = circle.map((p) => p.computedEl);
    for (let i = 1; i <= 5; i++) expect(el[i]).toBeGreaterThan(el[i - 1]);       // 500 -> 2500 m
    for (let i = 6; i < el.length; i++) expect(el[i]).toBeLessThan(el[i - 1]);   // back down
    // a payload below the station horizon is negative, well above it is positive
    expect(el[0]).toBeLessThan(0);                    // 500 m is still below the station (484 m + 1.5 km away)
    expect(el[5]).toBeGreaterThan(40);
  });

  it("matches the elevation of a flat-earth right triangle within the curvature error", () => {
    for (const p of circle) {
      const flat = deg(Math.atan2(p.alt - GS.alt, RADIUS_M));
      expect(Math.abs(p.computedEl - flat)).toBeLessThan(0.25);
    }
  });

  it("a calibration made at the old station is flagged once the coordinates change", () => {
    const moved = computePointingLTC(GS.lat + 0.001, GS.lng, GS.alt, DOME.lat, DOME.lng, DOME.alt);
    // same tripod offset, different station: the dialled azimuth no longer lands on 335
    expect(Math.abs(toTripodAzimuth(moved.azimuth, calibration) - 335)).toBeGreaterThan(1);
  });

  it("writes the results for the report when asked", () => {
    const out = process.env.BLESS_POINTING_OUT;
    if (!out) return;
    fs.writeFileSync(out, JSON.stringify({
      gs: GS, dome: DOME, tripodAtDome: TRIPOD_AT_DOME, radiusM: RADIUS_M,
      domeTrue, calibration: { azOffset: calibration.azOffset, elOffset: calibration.elOffset },
      circle,
    }, null, 2));
  });
});
