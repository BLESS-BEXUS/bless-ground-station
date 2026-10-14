import fs from "fs";
import path from "path";
import type { BlessPacket } from "./protocol";
import type { GsRfSnapshot } from "./gsLmac";

const HALOW_HEADER =
  "receivedAt,timestamp,packetCount,latitude,longitude,altitude,gpsFix,gpsSats," +
  "rssi,snr,freqDevHz,successRate,noiseFloor,txMcs," +
  "systemState,halowCurrMa,chipTempC,heaterPower," +
  "pressurePa,extTempC,intTempC,extHumidityRh,radiationCps,errorFlags,halowStatus," +
  "gsRssi,gsSnr,gsFreqDev,gsMcs\n";

const ELINK_HEADER =
  "receivedAt,timestamp,packetCount,latitude,longitude,altitude,gpsFix,gpsSats," +
  "rssi,snr,freqDevHz,successRate,noiseFloor,txMcs," +
  "systemState,halowCurrMa,chipTempC,heaterPower," +
  "pressurePa,extTempC,intTempC,extHumidityRh,radiationCps,errorFlags,halowStatus\n";

function packetToRow(p: BlessPacket, includeGs = false): string {
  const base = [
    p.receivedAt,
    p.timestamp,
    p.packetCount,
    p.latitude.toFixed(7),
    p.longitude.toFixed(7),
    p.altitude,
    p.gpsFix ? 1 : 0,
    p.gpsSats,
    p.rssi,
    p.snr,
    p.freqDevHz,
    p.successRate,
    p.noiseFloor,
    p.txMcs,
    p.systemState,
    p.halowCurrMa,
    p.chipTempC.toFixed(2),
    p.heaterPower,
    p.pressurePa,
    p.extTempC.toFixed(2),
    p.intTempC.toFixed(2),
    p.extHumidityRh.toFixed(2),
    p.radiationCps,
    p.errorFlags,
    p.halowStatus,
  ];
  if (includeGs) {
    base.push(
      String(p.gsRssi ?? ""),
      String(p.gsSnr ?? ""),
      String(p.gsFreqDev ?? ""),
      String(p.gsMcs ?? ""),
      String(p.gsNoiseFloor ?? ""),
      String(p.gsPer ?? ""),
    );
  }
  return base.join(",");
}

export class MissionLogger {
  private logDir: string;
  private baseFilename: string;
  private filePath: string;
  private header: string;
  private includeGs: boolean;
  private active = false;
  private rowCount = 0;

  constructor(logDir = "./logs", filename: string, header: string, includeGs = false) {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.logDir = logDir;
    this.baseFilename = filename;
    this.filePath = path.join(logDir, filename);
    this.header = header;
    this.includeGs = includeGs;
  }

  open(): void {
    console.log(`[logger] Ready — ${this.filePath} (logging OFF)`);
  }

  start(sessionId = new Date().toISOString().replace(/[:.]/g, "-")): void {
    if (this.active) return;
    const parsed = path.parse(this.baseFilename);
    this.filePath = path.join(
      this.logDir,
      `${parsed.name}_${sessionId}${parsed.ext || ".csv"}`,
    );
    this.active = true;
    this.rowCount = 0;
    fs.writeFileSync(this.filePath, this.header, "utf-8");
    console.log(`[logger] START — ${this.filePath}`);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    console.log(`[logger] STOP — ${this.filePath} (${this.rowCount} rows saved)`);
  }

  write(p: BlessPacket): void {
    if (!this.active) return;
    fs.appendFileSync(this.filePath, packetToRow(p, this.includeGs) + "\n", "utf-8");
    this.rowCount++;
  }

  close(): void {
    this.stop();
  }

  isActive(): boolean { return this.active; }
  getFilePath(): string { return this.filePath; }
  getRowCount(): number { return this.rowCount; }
}

const GS_RF_HEADER =
  "receivedAt,uptimeMs,freqMHz,bwMHz,rssi,snr,noiseFloor,background," +
  "rxFrames,rxKbps,rxErrPhy,rxErrFcs,rxGain,txFrames,txPerPct,txKbps,txMcs,txPowerIndex," +
  "chipTempC,vcc,stations\n";

/** One row per "LMAC STATUS" dump of the ground-station HaLow module. */
export class GsRfLogger {
  private active = false;
  private rowCount = 0;
  private filePath: string;

  constructor(private readonly logDir = "./logs", private readonly baseFilename = "gs_rf_live.csv") {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.filePath = path.join(logDir, baseFilename);
  }

  start(sessionId = new Date().toISOString().replace(/[:.]/g, "-")): void {
    if (this.active) return;
    const parsed = path.parse(this.baseFilename);
    this.filePath = path.join(this.logDir, `${parsed.name}_${sessionId}${parsed.ext || ".csv"}`);
    this.active = true;
    this.rowCount = 0;
    fs.writeFileSync(this.filePath, GS_RF_HEADER, "utf-8");
  }

  stop(): void {
    this.active = false;
  }

  write(s: GsRfSnapshot): void {
    if (!this.active) return;
    const cell = (v: number | null) => (v === null ? "" : String(v));
    const row = [
      new Date(s.t).toISOString(), cell(s.uptimeMs), cell(s.freqMHz), cell(s.bwMHz),
      cell(s.rssi), cell(s.snr), cell(s.noiseFloor), cell(s.background),
      cell(s.rxFrames), cell(s.rxKbps), cell(s.rxErrPhy), cell(s.rxErrFcs), cell(s.rxGain),
      cell(s.txFrames), cell(s.txPerPct), cell(s.txKbps), cell(s.txMcs), cell(s.txPowerIndex),
      cell(s.chipTempC), cell(s.vcc), cell(s.stations),
    ].join(",");
    fs.appendFileSync(this.filePath, row + "\n", "utf-8");
    this.rowCount++;
  }

  isActive(): boolean { return this.active; }
  getFilePath(): string { return this.filePath; }
  getRowCount(): number { return this.rowCount; }
}

export interface MissionTimeSyncEvent {
  commandId: number;
  missionTimeMs: 0;
  t0UtcApprox: string;
  commandSentUtc: string;
  confirmedUtc: string;
  source: string;
}

const MISSION_EVENT_HEADER =
  "event,commandId,status,missionTimeMs,t0UtcApprox,commandSentUtc,confirmedUtc,source\n";

export class MissionEventLogger {
  private readonly logDir: string;
  private readonly baseFilename: string;
  private filePath: string;
  private rowCount = 0;
  private active = false;

  constructor(logDir = "./logs", filename = "mission_events.csv") {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.logDir = logDir;
    this.baseFilename = filename;
    this.filePath = path.join(logDir, filename);
  }

  start(sessionId = new Date().toISOString().replace(/[:.]/g, "-")): void {
    const parsed = path.parse(this.baseFilename);
    this.filePath = path.join(
      this.logDir,
      `${parsed.name}_${sessionId}${parsed.ext || ".csv"}`,
    );
    this.rowCount = 0;
    this.active = true;
    fs.writeFileSync(this.filePath, MISSION_EVENT_HEADER, "utf-8");
    console.log(`[event-logger] START — ${this.filePath}`);
  }

  writeMissionTimeSync(event: MissionTimeSyncEvent): void {
    if (!this.active) this.start();
    const row = [
      "MISSION_TIME_SYNC",
      event.commandId,
      "CONFIRMED",
      event.missionTimeMs,
      event.t0UtcApprox,
      event.commandSentUtc,
      event.confirmedUtc,
      event.source,
    ].join(",");
    fs.appendFileSync(this.filePath, row + "\n", "utf-8");
    this.rowCount++;
  }

  /**
   * A change made to the ground-station HaLow module, in the same file and columns
   * as the time syncs: the setting goes in `source` (e.g. TXPOWER=12), so RSSI and
   * PDR can be compared against the radio settings that were active at the time.
   */
  writeGroundRadioConfig(event: {
    status: "OK" | "FAILED";
    setting: string;
    sentUtc: string;
    finishedUtc: string;
  }): void {
    if (!this.active) this.start();
    const row = [
      "GROUND_HALOW_CONFIG",
      "",
      event.status,
      "",
      "",
      event.sentUtc,
      event.finishedUtc,
      event.setting.replace(/[,\r\n]/g, ";"),
    ].join(",");
    fs.appendFileSync(this.filePath, row + "\n", "utf-8");
    this.rowCount++;
  }

  getFilePath(): string { return this.filePath; }
  getRowCount(): number { return this.rowCount; }
}
