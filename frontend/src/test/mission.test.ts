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
});
