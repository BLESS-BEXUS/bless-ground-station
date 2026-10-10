import { describe, expect, it } from "vitest";
import { formatMissionTime, parseClockInput } from "@/lib/missionClock";

describe("mission clock formatting", () => {
  it("counts down before T=0 and up after it", () => {
    expect(formatMissionTime(-4 * 3600 * 1000)).toBe("T-04:00:00");
    expect(formatMissionTime(-1)).toBe("T-00:00:01");
    expect(formatMissionTime(0)).toBe("T+00:00:00");
    expect(formatMissionTime(999)).toBe("T+00:00:00");
    expect(formatMissionTime(3_725_000)).toBe("T+01:02:05");
  });

  it("keeps counting hours past 99", () => {
    expect(formatMissionTime(100 * 3600 * 1000)).toBe("T+100:00:00");
  });
});

describe("mission clock input", () => {
  it("parses HH:MM:SS and MM:SS", () => {
    expect(parseClockInput("04:00:00")).toBe(14_400);
    expect(parseClockInput("4:00:00")).toBe(14_400);
    expect(parseClockInput("10:30")).toBe(630);
    expect(parseClockInput(" 00:00:07 ")).toBe(7);
  });

  it("rejects malformed values", () => {
    expect(parseClockInput("")).toBeNull();
    expect(parseClockInput("4")).toBeNull();
    expect(parseClockInput("00:60:00")).toBeNull();
    expect(parseClockInput("00:00:61")).toBeNull();
    expect(parseClockInput("aa:bb:cc")).toBeNull();
    expect(parseClockInput("-04:00:00")).toBeNull();
    expect(parseClockInput("1:2:3:4")).toBeNull();
  });
});
