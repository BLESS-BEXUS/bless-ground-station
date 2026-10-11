import { describe, expect, it } from "vitest";
import {
  normalizeRoutePoint, routeCounts, routeRuns, rssiColor, rssiFraction, rssiStats, rssiTrack,
  NO_RSSI_COLOR,
  RSSI_MAX_DBM, RSSI_MIN_DBM, type RouteLink, type RoutePoint,
} from "@/lib/route";

function pt(n: number, link: RouteLink, rssi: number | null = -70): RoutePoint {
  return { lat: 67 + n / 100, lng: 21, alt: 1000 + n, t: n * 1000, link, pkt: n, rssi };
}

describe("route runs", () => {
  it("returns nothing for an empty route", () => {
    expect(routeRuns([])).toEqual([]);
  });

  it("keeps a single-link route as one run", () => {
    const runs = routeRuns([pt(1, "halow"), pt(2, "halow"), pt(3, "halow")]);
    expect(runs).toHaveLength(1);
    expect(runs[0].link).toBe("halow");
    expect(runs[0].positions).toHaveLength(3);
  });

  it("switches color when HaLow GNSS stops and keeps the line continuous", () => {
    const runs = routeRuns([pt(1, "halow"), pt(2, "halow"), pt(3, "elink"), pt(4, "elink"), pt(5, "halow")]);
    expect(runs.map((r) => r.link)).toEqual(["halow", "elink", "halow"]);
    // each new run starts at the previous run's last point, so there is no gap
    expect(runs[1].positions[0]).toEqual(runs[0].positions[runs[0].positions.length - 1]);
    expect(runs[2].positions[0]).toEqual(runs[1].positions[runs[1].positions.length - 1]);
    // the first segment into a new link takes the new link's color
    expect(runs[1].positions).toEqual([[67.02, 21], [67.03, 21], [67.04, 21]]);
  });
});

describe("route counts", () => {
  it("counts points per link", () => {
    expect(routeCounts([pt(1, "halow"), pt(2, "elink"), pt(3, "elink")])).toEqual({ halow: 1, elink: 2 });
  });
});

describe("rssi scale", () => {
  it("spans the receiver sensitivity floor to the practical ceiling", () => {
    expect(RSSI_MIN_DBM).toBe(-107);
    expect(rssiFraction(-107)).toBe(0);
    expect(rssiFraction(RSSI_MAX_DBM)).toBe(1);
    expect(rssiFraction(-200)).toBe(0);   // clamped, never out of range
    expect(rssiFraction(+6)).toBe(1);
  });

  it("goes from red (weak) through yellow to green (strong)", () => {
    const parse = (c: string) => c.match(/\d+/g)!.map(Number);
    const [rWeak, gWeak] = parse(rssiColor(-105));
    const [rMid, gMid] = parse(rssiColor(-61));
    const [rStrong, gStrong] = parse(rssiColor(-32));
    expect(rWeak).toBeGreaterThan(gWeak * 3);        // reddish
    expect(rMid).toBeGreaterThan(200);
    expect(gMid).toBeGreaterThan(190);               // yellow: both high
    expect(gStrong).toBeGreaterThan(rStrong);        // greenish
  });

  it("changes smoothly between neighbouring readings", () => {
    const a = rssiColor(-70).match(/\d+/g)!.map(Number);
    const b = rssiColor(-71).match(/\d+/g)!.map(Number);
    const maxStep = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    expect(maxStep).toBeLessThan(12);
  });
});

describe("rssi track and stats", () => {
  it("fades from one reading to the next along the leg", () => {
    const lines = rssiTrack([pt(1, "halow", -40), pt(2, "halow", -100)]);
    expect(lines.length).toBeGreaterThan(3);
    // strong to weak: the RSSI never increases along the line
    const values = lines.map((l) => l.rssi as number);
    expect(values).toEqual([...values].sort((x, y) => y - x));
    expect(values[0]).toBeGreaterThan(-55);
    expect(values[values.length - 1]).toBeLessThan(-85);
  });

  it("covers the whole route without gaps", () => {
    const pts = [pt(1, "halow", -50), pt(2, "halow", -70), pt(3, "elink", -90)];
    const lines = rssiTrack(pts);
    const first = lines[0].positions[0];
    const lastLine = lines[lines.length - 1];
    const last = lastLine.positions[lastLine.positions.length - 1];
    expect(first).toEqual([67.01, 21]);
    expect(last[0]).toBeCloseTo(67.03, 9);
  });

  it("draws a leg with a missing reading in grey instead of leaving a hole", () => {
    const lines = rssiTrack([pt(1, "halow", -60), pt(2, "halow", null), pt(3, "elink", -80)]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.color === NO_RSSI_COLOR && l.rssi === null)).toBe(true);
  });

  it("merges neighbouring pieces of the same shade", () => {
    const steady = Array.from({ length: 50 }, (_, i) => pt(i, "halow", -70));
    expect(rssiTrack(steady)).toHaveLength(1);
  });

  it("needs at least two points", () => {
    expect(rssiTrack([])).toEqual([]);
    expect(rssiTrack([pt(1, "halow", -70)])).toEqual([]);
  });

  it("summarizes only valid readings", () => {
    const pts = [pt(1, "halow", -60), pt(2, "halow", null), pt(3, "elink", -80)];
    expect(rssiStats(pts)).toEqual({ min: -80, max: -60, mean: -70 });
    expect(rssiStats([pt(1, "halow", null)])).toBeNull();
  });
});

describe("route point normalization", () => {
  it("turns a missing RSSI (older backend) into null", () => {
    const { rssi: _omit, ...legacy } = pt(1, "halow", -60);
    expect(normalizeRoutePoint(legacy).rssi).toBeNull();
    expect(normalizeRoutePoint({ ...legacy, rssi: -72 }).rssi).toBe(-72);
    expect(normalizeRoutePoint({ ...legacy, rssi: Number.NaN }).rssi).toBeNull();
  });
});
