import fs from "fs";
import path from "path";
import type { BlessPacket } from "./protocol";

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

  getFilePath(): string { return this.filePath; }
  getRowCount(): number { return this.rowCount; }
}
