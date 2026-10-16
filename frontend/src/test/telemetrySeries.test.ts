import { describe, expect, it } from "vitest";
import { groundRadio, payloadRadio, plausibleRssi } from "@/lib/radio";
import {
  buildGroundRadioSeries,
  buildPayloadRadioSeries,
  downsample,
  flagRuns,
  groundSpeedKmh,
  gsRfFromSnapshot,
  packetIntervals,
  sampleFromPacket,
  seriesStats,
  verticalSpeed,
  windowed,
  type TelemetrySample,
} from "@/lib/telemetrySeries";

const T0 = Date.parse("2026-10-14T10:00:00Z");

function sample(i: number, over: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    t: T0 + i * 5000, count: i, uptimeMs: i * 5000, lat: 67.9, lng: 21.1, alt: 1000, sats: 12, fix: true,
    rssi: null, snr: null, noiseFloor: null, freqDevHz: null, gsRssi: null, gsSnr: null, gsNoiseFloor: null,
    gsFreqDev: null, pdr: 100, mcs: 0, gsMcs: null,
    gsPer: null, state: 2, halowCurrMa: 180, chipTempC: 30, heaterPower: 0, pressurePa: 90000, extTempC: 5,
    intTempC: 15, humidity: 40, radiationCps: 1, errorFlags: 0, ...over,
  };
}

describe("the payload's and the ground station's readings stay apart", () => {
  it("the payload's figures are only the payload's, while they are real readings", () => {
    const r = payloadRadio({ rssi: -70, snr: 20, noiseFloor: -90, freqDevHz: 500 });
    expect(r).toEqual({ rssi: -70, snr: 20, noiseFloor: -90, freqDevHz: 500 });
  });

  it("a payload that sends zeros has no reading: nothing is borrowed from the ground station", () => {
    const withGroundFigures = { rssi: 0, snr: 0, noiseFloor: 0, freqDevHz: 0, gsRssi: -67, gsSnr: 31, gsNoiseFloor: -98, gsFreqDev: -1200 };
    expect(payloadRadio(withGroundFigures)).toEqual({ rssi: null, snr: null, noiseFloor: null, freqDevHz: null });
  });

  it("the ground station's figures are only the ground module's, whatever the payload says", () => {
    const g = groundRadio({ gsRssi: -67, gsSnr: 31, gsNoiseFloor: -98, gsFreqDev: -1200, rssi: -40, snr: 40 } as never);
    expect(g).toEqual({ rssi: -67, snr: 31, noiseFloor: -98, freqDevHz: -1200 });
  });

  it("shows nothing, not 0, when a side has no reading", () => {
    expect(payloadRadio({ rssi: 0, snr: 0, noiseFloor: 0, freqDevHz: 0 })).toEqual({ rssi: null, snr: null, noiseFloor: null, freqDevHz: null });
    expect(groundRadio({ gsRssi: 0, gsSnr: 0, gsNoiseFloor: 0 })).toEqual({ rssi: null, snr: null, noiseFloor: null, freqDevHz: null });
  });

  it("derives the noise floor as rssi - snr when it is not given, on each side", () => {
    expect(payloadRadio({ rssi: -70, snr: 25, noiseFloor: 0 }).noiseFloor).toBe(-95);
    expect(groundRadio({ gsRssi: -70, gsSnr: 25 }).noiseFloor).toBe(-95);
  });

  it("keeps a frequency deviation of the ground module even without an RSSI", () => {
    expect(groundRadio({ gsFreqDev: 900 }).freqDevHz).toBe(900);
    expect(payloadRadio({ rssi: 0, freqDevHz: 900 }).freqDevHz).toBeNull();
  });

  it("treats 0 dBm and absurd values as no reading", () => {
    expect(plausibleRssi(0)).toBe(false);
    expect(plausibleRssi(-150)).toBe(false);
    expect(plausibleRssi(null)).toBe(false);
    expect(plausibleRssi(-80)).toBe(true);
  });
});

describe("turning a packet into a sample", () => {
  const packet = {
    timestamp: 120_000, packetCount: 24, latitude: 67.89, longitude: 21.08, altitude: 339, gpsFix: true, gpsSats: 12,
    rssi: 0, snr: 0, freqDevHz: 0, successRate: 100, noiseFloor: 0, txMcs: 0, systemState: 2,
    halowCurrMa: 175, chipTempC: 32, heaterPower: 0, pressurePa: 98621, extTempC: 21.2, intTempC: 22.3,
    extHumidityRh: 25.6, radiationCps: 0, errorFlags: 1, receivedAt: "2026-10-14T10:00:00.000Z",
    gsRssi: -66, gsSnr: 30, gsNoiseFloor: -96, gsFreqDev: 800, gsMcs: 0, gsPer: 0,
  };

  it("keeps every field, and keeps the ground station's figures in their own fields", () => {
    const s = sampleFromPacket(packet)!;
    expect(s.t).toBe(T0);
    expect(s.alt).toBe(339);
    expect(s.pressurePa).toBe(98621);
    expect(s.humidity).toBe(25.6);
    // the payload sent zeros: it has no reading, and the ground station's figures do not stand in for it
    expect(s.rssi).toBeNull();
    expect(s.snr).toBeNull();
    expect(s.noiseFloor).toBeNull();
    expect(s.freqDevHz).toBeNull();
    expect(s.gsRssi).toBe(-66);
    expect(s.gsSnr).toBe(30);
    expect(s.gsNoiseFloor).toBe(-96);
    expect(s.gsFreqDev).toBe(800);
  });

  it("when both sides have a reading, each keeps its own", () => {
    const s = sampleFromPacket({ ...packet, rssi: -40, snr: 38, noiseFloor: -78, freqDevHz: 100 })!;
    expect([s.rssi, s.snr, s.noiseFloor, s.freqDevHz]).toEqual([-40, 38, -78, 100]);
    expect([s.gsRssi, s.gsSnr, s.gsNoiseFloor, s.gsFreqDev]).toEqual([-66, 30, -96, 800]);
  });

  it("ignores things that are not packets, and tolerates missing fields", () => {
    expect(sampleFromPacket(null)).toBeNull();
    expect(sampleFromPacket("x")).toBeNull();
    const s = sampleFromPacket({ altitude: 10 }, 5_000)!;
    expect(s.t).toBe(5_000);
    expect(s.alt).toBe(10);
    expect(s.rssi).toBeNull();
    expect(s.pressurePa).toBeNull();
  });

  it("reads a ground-module dump", () => {
    const g = gsRfFromSnapshot({ t: 5, rssi: -67, snr: 31, noiseFloor: -98, freqMHz: 866, bwMHz: 1, chipTempC: 35 })!;
    expect(g.rssi).toBe(-67);
    expect(g.t).toBe(5);
    expect(gsRfFromSnapshot({ rssi: 1 })).toBeNull();
    expect(gsRfFromSnapshot(undefined)).toBeNull();
  });
});

describe("windows and decimation", () => {
  const many = Array.from({ length: 100 }, (_, i) => sample(i));

  it("counts the window back from the newest sample, not from the clock", () => {
    const last60s = windowed(many, 60_000);
    expect(last60s[last60s.length - 1]).toBe(many[99]);
    expect(last60s[0].t).toBeGreaterThanOrEqual(many[99].t - 60_000);
    expect(last60s.length).toBe(13);                     // 60 s / 5 s + the boundary sample
    expect(windowed(many, null)).toBe(many);
    expect(windowed([], 1000)).toEqual([]);
  });

  it("limits the points but keeps the first and the newest", () => {
    const reduced = downsample(many, 10);
    expect(reduced).toHaveLength(10);
    expect(reduced[0]).toBe(many[0]);
    expect(reduced[9]).toBe(many[99]);
    expect(downsample(many, 500)).toBe(many);
  });
});

describe("derived series", () => {
  it("vertical speed in m/s from the altitude a few samples back", () => {
    const climbing = Array.from({ length: 10 }, (_, i) => sample(i, { alt: 1000 + i * 25 }));   // 5 m/s
    const v = verticalSpeed(climbing, 3);
    expect(v[0]).toBeNull();
    expect(v[2]).toBeNull();
    expect(v[3]).toBeCloseTo(5, 6);
    expect(v[9]).toBeCloseTo(5, 6);
  });

  it("is null when the altitude is missing", () => {
    const s = [sample(0), sample(1), sample(2), sample(3, { alt: null })];
    expect(verticalSpeed(s, 3)[3]).toBeNull();
  });

  it("ground speed in km/h from the GNSS position", () => {
    // 0.0001 degrees of latitude is about 11.1 m every 5 s: 2.2 m/s, about 8 km/h
    const walking = Array.from({ length: 6 }, (_, i) => sample(i, { lat: 67.9 + i * 0.0001 }));
    const g = groundSpeedKmh(walking, 3)[5]!;
    expect(g).toBeGreaterThan(7.7);
    expect(g).toBeLessThan(8.3);
  });

  it("does not report a speed from positions without a GNSS fix", () => {
    const s = [sample(0), sample(1), sample(2), sample(3, { fix: false, lat: 68 })];
    expect(groundSpeedKmh(s, 3)[3]).toBeNull();
  });

  it("packet intervals in seconds, and a gap stands out", () => {
    const s = [sample(0), sample(1), sample(2), { ...sample(3), t: T0 + 40_000 }];
    expect(packetIntervals(s)).toEqual([null, 5, 5, 30]);
  });
});

describe("statistics", () => {
  it("min, max, mean and last, ignoring missing values", () => {
    expect(seriesStats([null, 3, 5, null, 10])).toEqual({ min: 3, max: 10, mean: 6, last: 10, count: 3 });
    expect(seriesStats([4, null])?.last).toBe(4);
    expect(seriesStats([null, null])).toBeNull();
    expect(seriesStats([])).toBeNull();
  });
});

describe("radio series: one per provider", () => {
  const idleDump = { t: T0 + 7500, rssi: null, snr: null, noiseFloor: null };
  const dumps = [{ t: T0 + 2500, rssi: -71, snr: 26, noiseFloor: -97 }, idleDump].map((d) => ({
    ...d, background: -60, freqMHz: 866, bwMHz: 1, rxFrames: 1, rxKbps: 1, txPerPct: 0, txMcs: 0, chipTempC: 35, vcc: 3.3,
  }));

  it("the payload series has only what the payload measured, and skips packets with no reading", () => {
    const samples = [
      sample(0, { rssi: -70, snr: 25, noiseFloor: -95, freqDevHz: 100, gsRssi: -60 }),
      sample(2, { rssi: -72, snr: 24, noiseFloor: -96, freqDevHz: 120 }),
      sample(4, { gsRssi: -61, gsSnr: 30 }),               // the payload sent zeros; the ground module had a figure
    ];
    const series = buildPayloadRadioSeries(samples);
    expect(series.map((p) => p.t)).toEqual([T0, T0 + 10_000]);
    expect(series.map((p) => p.rssi)).toEqual([-70, -72]);
    expect(series.every((p) => p.rssi !== -60 && p.rssi !== -61)).toBe(true);
  });

  it("the ground series has only the ground module's dumps, never a payload figure", () => {
    const samples = [
      sample(0, { rssi: -40, snr: 38 }),                    // payload readings: not in the ground series
      sample(2, { gsFreqDev: 900 }),
    ];
    const series = buildGroundRadioSeries(samples, dumps);
    expect(series.map((p) => p.t)).toEqual([T0 + 2500, T0 + 10_000]);
    expect(series.map((p) => p.rssi)).toEqual([-71, null]);          // the idle dump is not a point
    expect(series.map((p) => p.freqDevHz)).toEqual([null, 900]);
    expect(series.some((p) => p.rssi === -40)).toBe(false);
  });

  it("the two series never share a point", () => {
    const samples = [sample(0, { rssi: -40, snr: 38, gsRssi: -54 }), sample(2, { rssi: -41, snr: 37, gsRssi: -55 })];
    const payload = buildPayloadRadioSeries(samples);
    const ground = buildGroundRadioSeries(samples, dumps);
    expect(payload.map((p) => p.rssi)).toEqual([-40, -41]);
    expect(ground.map((p) => p.rssi)).toEqual([-71]);
  });
});

describe("error flags over time", () => {
  it("finds the stretches in which each bit was set", () => {
    const flags = [0, 1, 1, 0, 0, 1, 0, 3];
    const s = flags.map((f, i) => sample(i, { errorFlags: f }));
    const runs = flagRuns(s, [0, 1]);
    expect(runs.get(0)).toEqual([
      { from: s[1].t, to: s[3].t },
      { from: s[5].t, to: s[6].t },
      { from: s[7].t, to: s[7].t },
    ]);
    expect(runs.get(1)).toEqual([{ from: s[7].t, to: s[7].t }]);
  });

  it("returns nothing for a clean flight", () => {
    const s = [sample(0), sample(1)];
    expect(flagRuns(s, [0, 1, 2]).get(0)).toEqual([]);
  });
});
