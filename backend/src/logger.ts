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
  private filename: string;
  private filePath: string;
  private header: string;
  private rows: string[] = [];
  private includeGs: boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  constructor(logDir = "./logs", filename: string, header: string, includeGs = false) {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    this.logDir = logDir;
    this.filename = filename;
    this.filePath = path.join(logDir, filename);
    this.header = header;
    this.includeGs = includeGs;
  }

  // Called once at startup — does NOT start logging automatically
  open(): void {
    console.log(`[logger] Ready — ${this.filePath} (logging OFF)`);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.rows = [];
    this.flush();
    this.timer = setInterval(() => this.flush(), 30_000);
    console.log(`[logger] START — ${this.filePath}`);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.flush();
    console.log(`[logger] STOP — ${this.filePath} (${this.rows.length} rows saved)`);
  }

  write(p: BlessPacket): void {
    if (!this.active) return;
    this.rows.push(packetToRow(p, this.includeGs));
  }

  private flush(): void {
    const content = this.header + this.rows.join("\n") + (this.rows.length ? "\n" : "");
    fs.writeFileSync(this.filePath, content, "utf-8");
  }

  close(): void {
    this.stop();
  }

  isActive(): boolean { return this.active; }
  getFilePath(): string { return this.filePath; }
  getRowCount(): number { return this.rows.length; }
}
