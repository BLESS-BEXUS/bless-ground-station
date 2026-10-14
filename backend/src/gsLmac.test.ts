import assert from "node:assert/strict";
import test from "node:test";
import { LmacStatusParser, type GsRfSnapshot } from "./gsLmac";

/** The block exactly as it was pasted from the Arduino IDE, with its markdown fences. */
const PASTED_BLOCK = `LMAC STATUS:


\`\`\`
local: 82:59:13:89:90:c0 AID= 0

\`\`\`


\`\`\`
freq= 866.0 bw=1 chn=0 bgr=-60 iq=0:50:-1:0 dc=0:0(-5:14) tx=*5 dly=0:0:0 sif:rsp=0:0(0)

\`\`\`


\`\`\`
chn:  866.0  867.0

\`\`\`


\`\`\`
bgr:    -60    -60

\`\`\`


\`\`\`
buf: free=78 tq=0 sq=0 ac=0:0:0:0 agg=0:0:0:0 statq=0 rxq=0:0 skb=0:0 rxb=120K

\`\`\`


\`\`\`
irq: ac=3 bkn=0 bo(rts:frm)=0:0:0:0:3 to(rts:frm)=0:0 rx=0

\`\`\`


\`\`\`
tx : cnt=3 dly=0:0ms mcast(bw:mcs)=2:0 agg=1(6026,3:0) data=0KB(0kbps) dur=7ms cca=15 per=0% est_rate=7kbps fail=0 drop=0

\`\`\`


\`\`\`
rx : cnt=0 bus=0ms cts_bm=0:0 pks=0 data=0KB(0kbps) dur= 0ms err(phy:fcs)=0:0 ecode=0x0 rssie= 0:0 cache_rxq= 0:0

\`\`\`


\`\`\`
dbg: dtmd=0:0:0 stamap=0x0 sleepmap=0x0 flag=0x0 rxdp=0 kerr=0 mic=0 lerr=0 kick=0 csc=0 rst=9 ovf=0 nob=0 tsnr=0 rssi=0 rxdut=0% txp=0 rxg=5

\`\`\`


\`\`\`
cca: 4s st12= 0:0 mid1224= 0:0:0:0 ed1224= 0:0 ch_bz= 0

\`\`\`


\`\`\`
chip-temperature:35, vcc:3.30, vdd13b:1.32, vdd13c:1.31

\`\`\`


\`\`\`
sta_list: no sta

\`\`\`


\`\`\`
[257118]

\`\`\`
`;

function parseAll(text: string, clock = () => 1_000): GsRfSnapshot[] {
  const parser = new LmacStatusParser(clock);
  const found: GsRfSnapshot[] = [];
  for (const line of text.split("\n")) {
    const snapshot = parser.feed(line);
    if (snapshot) found.push(snapshot);
  }
  return found;
}

test("reads the block that was pasted from the module", () => {
  const [snapshot] = parseAll(PASTED_BLOCK);
  assert.ok(snapshot);
  assert.equal(snapshot.t, 1_000);
  assert.equal(snapshot.uptimeMs, 257_118);
  assert.equal(snapshot.freqMHz, 866.0);
  assert.equal(snapshot.bwMHz, 1);
  assert.equal(snapshot.background, -60);
  assert.equal(snapshot.txFrames, 3);
  assert.equal(snapshot.txMcs, 0);
  assert.equal(snapshot.txPerPct, 0);
  assert.equal(snapshot.txKbps, 7);
  assert.equal(snapshot.rxFrames, 0);
  assert.equal(snapshot.rxGain, 5);
  assert.equal(snapshot.txPowerIndex, 0);
  assert.equal(snapshot.chipTempC, 35);
  assert.equal(snapshot.vcc, 3.3);
  assert.equal(snapshot.stations, 0);
});

test("an idle module (rssi=0, nothing received) gives no RSSI, SNR or noise floor", () => {
  const [snapshot] = parseAll(PASTED_BLOCK);
  assert.equal(snapshot.rssi, null);
  assert.equal(snapshot.snr, null);
  assert.equal(snapshot.noiseFloor, null);
});

test("when frames are received, RSSI and SNR come from the dbg line and noise floor is rssi - snr", () => {
  const active = PASTED_BLOCK
    .replace("rx : cnt=0 bus=0ms cts_bm=0:0 pks=0 data=0KB(0kbps)", "rx : cnt=12 bus=0ms cts_bm=0:0 pks=12 data=1KB(4kbps)")
    .replace("tsnr=0 rssi=0", "tsnr=31 rssi=-67");
  const [snapshot] = parseAll(active);
  assert.equal(snapshot.rssi, -67);
  assert.equal(snapshot.snr, 31);
  assert.equal(snapshot.noiseFloor, -98);
  assert.equal(snapshot.rxFrames, 12);
  assert.equal(snapshot.rxKbps, 4);
});

test("works on the raw serial output without any fences", () => {
  const raw = PASTED_BLOCK.split("\n").filter((l) => !l.startsWith("```")).join("\r\n");
  const [snapshot] = parseAll(raw);
  assert.equal(snapshot.freqMHz, 866.0);
  assert.equal(snapshot.uptimeMs, 257_118);
});

test("a stream of blocks gives one snapshot per block, in order", () => {
  const second = PASTED_BLOCK.replace("[257118]", "[267118]").replace("chip-temperature:35", "chip-temperature:36");
  const snapshots = parseAll(PASTED_BLOCK + "\n" + second);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].chipTempC, 35);
  assert.equal(snapshots[1].chipTempC, 36);
  assert.equal(snapshots[1].uptimeMs, 267_118);
});

test("a block cut before its closing counter is still delivered when the next one starts", () => {
  const cut = PASTED_BLOCK.split("\n").filter((l) => !l.includes("[257118]")).join("\n");
  const snapshots = parseAll(cut + "\n" + PASTED_BLOCK);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].uptimeMs, null);
  assert.equal(snapshots[1].uptimeMs, 257_118);
});

test("ignores lines outside a block and unrelated text", () => {
  const parser = new LmacStatusParser();
  assert.equal(parser.feed("rx0: rssi=-60 freqDev=1500 mcs=0 bw=1MHz"), null);
  assert.equal(parser.feed("+RXDATA:67"), null);
  assert.equal(parser.feed("OK"), null);
  assert.equal(parser.isReading(), false);
});

test("an implausible RSSI is treated as no reading", () => {
  const bad = PASTED_BLOCK.replace("tsnr=0 rssi=0", "tsnr=20 rssi=-200");
  const [snapshot] = parseAll(bad);
  assert.equal(snapshot.rssi, null);
  assert.equal(snapshot.snr, null);
  assert.equal(snapshot.noiseFloor, null);
});
