/**
 * Reader for the periodic "LMAC STATUS" dump that the ground-station T-HaLow module
 * prints on its serial port:
 *
 *   LMAC STATUS:
 *   local: 82:59:13:89:90:c0 AID= 0
 *   freq= 866.0 bw=1 chn=0 bgr=-60 iq=... tx=*5 ...
 *   tx : cnt=3 ... mcast(bw:mcs)=2:0 ... per=0% est_rate=7kbps fail=0 drop=0
 *   rx : cnt=0 ... data=0KB(0kbps) ... err(phy:fcs)=0:0 ... rssie= 0:0 ...
 *   dbg: ... tsnr=0 rssi=0 rxdut=0% txp=0 rxg=5
 *   chip-temperature:35, vcc:3.30, ...
 *   sta_list: no sta
 *   [257118]
 *
 * Since the payload no longer reports RSSI / SNR / noise floor (it sends zeros),
 * these are the radio figures the ground station has: what the ground module itself
 * measures on the frames it receives from the payload.
 */

export interface GsRfSnapshot {
  /** Epoch ms at the ground station when the block was completed. */
  t: number;
  /** The module's own millisecond counter (the trailing "[257118]"). */
  uptimeMs: number | null;
  freqMHz: number | null;
  bwMHz: number | null;
  /** dBm of the last frame received; null when nothing was received (the module prints 0). */
  rssi: number | null;
  /** dB, from the same frame as `rssi`. */
  snr: number | null;
  /** dBm: rssi - snr, computed the same way the payload used to. */
  noiseFloor: number | null;
  /** The module's "bgr" background level; reported as is. */
  background: number | null;
  /** Frames received since the module's counters were last cleared. */
  rxFrames: number | null;
  rxKbps: number | null;
  rxErrPhy: number | null;
  rxErrFcs: number | null;
  rxGain: number | null;
  txFrames: number | null;
  /** Packet error rate of the module's transmissions, %. */
  txPerPct: number | null;
  txKbps: number | null;
  txMcs: number | null;
  txPowerIndex: number | null;
  chipTempC: number | null;
  vcc: number | null;
  /** Stations associated to this module; 0 when it prints "no sta". */
  stations: number | null;
}

type Partial_ = Partial<Record<keyof GsRfSnapshot, number | null>>;

function num(line: string, pattern: RegExp): number | null {
  const m = pattern.exec(line);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
}

function emptySnapshot(t: number): GsRfSnapshot {
  return {
    t, uptimeMs: null, freqMHz: null, bwMHz: null, rssi: null, snr: null, noiseFloor: null,
    background: null, rxFrames: null, rxKbps: null, rxErrPhy: null, rxErrFcs: null, rxGain: null,
    txFrames: null, txPerPct: null, txKbps: null, txMcs: null, txPowerIndex: null,
    chipTempC: null, vcc: null, stations: null,
  };
}

/**
 * Feed it every text line from the module. It returns a snapshot each time a block
 * is complete (at its "[nnnn]" line, or when the next block starts without one).
 */
export class LmacStatusParser {
  private fields: Partial_ = {};
  private open = false;
  private rssiRaw: number | null = null;
  private tsnrRaw: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** True while a block is being read, so callers can skip other handling of its lines. */
  isReading(): boolean {
    return this.open;
  }

  feed(rawLine: string): GsRfSnapshot | null {
    const line = rawLine.replace(/\r/g, "").trim();
    // the dump is often copied inside markdown fences; they are not part of it
    if (line === "" || line.startsWith("```")) return null;

    if (/^LMAC STATUS:?/i.test(line)) {
      const finished = this.open ? this.finish() : null;
      this.begin();
      return finished;
    }
    if (!this.open) return null;

    if (/^local:/i.test(line)) {
      // AID is only informative
    } else if (/^freq\s*=/i.test(line)) {
      this.fields.freqMHz = num(line, /freq\s*=\s*(-?\d+(?:\.\d+)?)/i);
      this.fields.bwMHz = num(line, /\bbw\s*=\s*(\d+)/i);
      this.fields.background = num(line, /\bbgr\s*=\s*(-?\d+)/i);
    } else if (/^tx\s*:/i.test(line)) {
      this.fields.txFrames = num(line, /\bcnt\s*=\s*(\d+)/i);
      this.fields.txPerPct = num(line, /\bper\s*=\s*(\d+)\s*%/i);
      this.fields.txKbps = num(line, /\best_rate\s*=\s*(\d+)\s*kbps/i);
      const mcast = /mcast\(bw:mcs\)\s*=\s*(\d+):(\d+)/i.exec(line);
      if (mcast) this.fields.txMcs = Number(mcast[2]);
    } else if (/^rx\s*:/i.test(line)) {
      this.fields.rxFrames = num(line, /\bcnt\s*=\s*(\d+)/i);
      this.fields.rxKbps = num(line, /\bdata\s*=\s*\d+\s*KB\(\s*(\d+)\s*kbps\)/i);
      const err = /err\(phy:fcs\)\s*=\s*(\d+):(\d+)/i.exec(line);
      if (err) {
        this.fields.rxErrPhy = Number(err[1]);
        this.fields.rxErrFcs = Number(err[2]);
      }
    } else if (/^dbg\s*:/i.test(line)) {
      this.tsnrRaw = num(line, /\btsnr\s*=\s*(-?\d+)/i);
      this.rssiRaw = num(line, /\brssi\s*=\s*(-?\d+)/i);
      this.fields.rxGain = num(line, /\brxg\s*=\s*(\d+)/i);
      this.fields.txPowerIndex = num(line, /\btxp\s*=\s*(-?\d+)/i);
    } else if (/^chip-temperature/i.test(line)) {
      this.fields.chipTempC = num(line, /chip-temperature\s*:\s*(-?\d+(?:\.\d+)?)/i);
      this.fields.vcc = num(line, /\bvcc\s*:\s*(\d+(?:\.\d+)?)/i);
    } else if (/^sta_list/i.test(line)) {
      this.fields.stations = /no sta/i.test(line) ? 0 : null;
    } else {
      const uptime = /^\[(\d+)\]$/.exec(line);
      if (uptime) {
        this.fields.uptimeMs = Number(uptime[1]);
        return this.finish();
      }
    }
    return null;
  }

  private begin(): void {
    this.fields = {};
    this.rssiRaw = null;
    this.tsnrRaw = null;
    this.open = true;
  }

  private finish(): GsRfSnapshot {
    this.open = false;
    const snapshot = emptySnapshot(this.now());
    for (const [key, value] of Object.entries(this.fields)) {
      (snapshot as unknown as Record<string, number | null>)[key] = value ?? null;
    }
    // The module prints 0 when no frame was received: that is "no reading", not 0 dBm.
    const rssiValid = this.rssiRaw !== null && this.rssiRaw < 0 && this.rssiRaw > -130;
    if (rssiValid) {
      snapshot.rssi = this.rssiRaw;
      snapshot.snr = this.tsnrRaw;
      if (this.tsnrRaw !== null) snapshot.noiseFloor = (this.rssiRaw as number) - this.tsnrRaw;
    }
    this.fields = {};
    return snapshot;
  }
}

