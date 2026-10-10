import { describe, expect, it } from "vitest";
import { computePointingLTC } from "@/pages/AntennaPage";
import { selectTelemetrySource } from "@/lib/linkSelection";

describe("mission source selection", () => {
  it("prioritizes fresh E-Link and falls back to HaLow", () => {
    expect(selectTelemetrySource(10_000, 9_000, 9_500, true, true)).toBe("elink");
    expect(selectTelemetrySource(20_000, 10_000, 19_000, true, true)).toBe("halow");
    expect(selectTelemetrySource(30_000, 10_000, 20_000, true, true)).toBe("none");
  });
});

describe("antenna pointing", () => {
  it("points to zenith for a balloon directly above the station", () => {
    const result = computePointingLTC(67.8856, 21.0786, 310, 67.8856, 21.0786, 1310);
    expect(result.elevation).toBeCloseTo(90, 6);
    expect(result.slantRangeKm).toBeCloseTo(1, 6);
  });

  it("reports negative elevation when the target is below the station", () => {
    // ~1.3 km to the north, 144 m lower than the station (GS 474 m, payload 330 m)
    const result = computePointingLTC(67.8856, 21.0786, 474, 67.8973, 21.0786, 330);
    expect(result.elevation).toBeLessThan(0);
    expect(result.elevation).toBeGreaterThan(-10);
    expect(result.azimuth).toBeCloseTo(0, 3);
  });
});
