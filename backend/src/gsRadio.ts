import type { BlessPacket } from "./protocol";
import type { GsRfSnapshot } from "./gsLmac";

type Key = "rssi" | "snr" | "noiseFloor" | "freqDev" | "mcs" | "per";

/** An RSSI of 0 dBm (or anything absurd) is the module saying "nothing received". */
export function plausibleRssi(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value < 0 && value > -130;
}

/**
 * The ground station's own radio measurements, the ones the payload no longer
 * reports. Every figure keeps the time it was read and expires, so a reading from
 * minutes ago is never presented as current.
 */
export class GsRadioLive {
  private readonly readings = new Map<Key, { value: number; at: number }>();

  constructor(
    private readonly freshMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  set(key: Key, value: number | null, at = this.now()): void {
    if (value === null || !Number.isFinite(value)) return;
    this.readings.set(key, { value, at });
  }

  /** The reading, or null when there is none or it is older than the freshness window. */
  get(key: Key): number | null {
    const reading = this.readings.get(key);
    if (!reading || this.now() - reading.at > this.freshMs) return null;
    return reading.value;
  }

  /** Noise floor is read directly when the module gives it, else rssi - snr. */
  noiseFloor(): number | null {
    const direct = this.get("noiseFloor");
    if (direct !== null) return direct;
    const rssi = this.get("rssi");
    const snr = this.get("snr");
    return rssi !== null && snr !== null ? rssi - snr : null;
  }

  /** The "rx0: rssi=-60 freqDev=1500 mcs=0 bw=1MHz" line. Returns true if it was one. */
  fromRx0Line(line: string): boolean {
    if (!line.startsWith("rx0:")) return false;
    const rssi = /rssi=(-?\d+)/.exec(line);
    const freqDev = /freqDev=(-?\d+)/.exec(line);
    const mcs = /mcs=(\d+)/.exec(line);
    if (rssi && plausibleRssi(Number(rssi[1]))) this.set("rssi", Number(rssi[1]));
    if (freqDev) this.set("freqDev", Number(freqDev[1]));
    if (mcs) this.set("mcs", Number(mcs[1]));
    return true;
  }

  /** The "tx0: snr=34 per=0" line. */
  fromTx0Line(line: string): boolean {
    if (!line.startsWith("tx0:")) return false;
    const snr = /snr=(-?\d+)/.exec(line);
    const per = /per=\s*(\d+)/.exec(line);
    if (snr) this.set("snr", Number(snr[1]));
    if (per) this.set("per", Number(per[1]));
    return true;
  }

  fromSnapshot(snapshot: GsRfSnapshot): void {
    this.set("rssi", snapshot.rssi, snapshot.t);
    this.set("snr", snapshot.snr, snapshot.t);
    this.set("noiseFloor", snapshot.noiseFloor, snapshot.t);
    this.set("per", snapshot.txPerPct, snapshot.t);
    // TX MCS only fills in the gap; a received frame's MCS (rx0 line) is more specific
    if (this.get("mcs") === null) this.set("mcs", snapshot.txMcs, snapshot.t);
  }

  /** Add the ground-station figures to a packet; fields stay undefined when stale. */
  attach(packet: BlessPacket): BlessPacket {
    const value = (v: number | null) => (v === null ? undefined : v);
    packet.gsRssi = value(this.get("rssi"));
    packet.gsSnr = value(this.get("snr"));
    packet.gsNoiseFloor = value(this.noiseFloor());
    packet.gsFreqDev = value(this.get("freqDev"));
    packet.gsMcs = value(this.get("mcs"));
    packet.gsPer = value(this.get("per"));
    return packet;
  }
}
