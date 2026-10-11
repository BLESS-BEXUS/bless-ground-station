import { describe, expect, it } from "vitest";
import {
  ackTimeoutFor,
  changeBreaksLink,
  distanceForAckTimeout,
  freqRangeValue,
  parseFreqRange,
  PAYLOAD_MISSION_DEFAULTS,
} from "@/lib/groundRadio";

describe("ground HaLow settings helpers", () => {
  it("builds the frequency range in 100 kHz units", () => {
    expect(freqRangeValue(866, 867)).toBe("8660,8670");
    expect(freqRangeValue(866.5, 867.5)).toBe("8665,8675");
    expect(parseFreqRange("8660,8670")).toEqual({ startMHz: 866, endMHz: 867 });
    expect(parseFreqRange("866,867")).toBeNull();
    expect(parseFreqRange(PAYLOAD_MISSION_DEFAULTS.FREQ_RANGE)).not.toBeNull();
  });

  it("computes the ACK timeout the way the payload does", () => {
    // 300 km link -> 2990, the payload's mission value
    expect(ackTimeoutFor(300)).toBe(2990);
    expect(`${ackTimeoutFor(300)}`).toBe(PAYLOAD_MISSION_DEFAULTS.ACKTMO);
    expect(ackTimeoutFor(1)).toBe(0);
    expect(ackTimeoutFor(0.2)).toBe(0);       // never negative
    expect(distanceForAckTimeout(2990)).toBe(300);
  });

  it("knows which settings break the link when changed on one end", () => {
    expect(changeBreaksLink("BSS_BW")).toBe(true);
    expect(changeBreaksLink("FREQ_RANGE")).toBe(true);
    expect(changeBreaksLink("TXPOWER")).toBe(false);
    expect(changeBreaksLink("TX_MCS")).toBe(false);
  });
});
