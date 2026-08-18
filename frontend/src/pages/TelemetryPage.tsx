import { useLiveData } from "@/hooks/useLiveData";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";

function StatusDot({ status }: { status: "nominal" | "warning" | "critical" }) {
  const cls =
    status === "nominal" ? "bg-success glow-secondary"
    : status === "warning" ? "bg-warning glow-warning"
    : "bg-destructive glow-destructive";
  return <div className={`h-2.5 w-2.5 rounded-full ${cls}`} />;
}

function getStatus(label: string, value: number): "nominal" | "warning" | "critical" {
  if (label === "RSSI") return value > -70 ? "nominal" : value > -85 ? "warning" : "critical";
  if (label === "SNR") return value > 15 ? "nominal" : value > 5 ? "warning" : "critical";
  if (label === "PDR") return value > 90 ? "nominal" : value > 70 ? "warning" : "critical";
  if (label === "Int. Temp") return value > 10 && value < 35 ? "nominal" : "warning";
  if (label === "Ext. Temp") return value > -40 ? "nominal" : value > -55 ? "warning" : "critical";
  if (label === "Chip Temp") return value < 70 ? "nominal" : value < 85 ? "warning" : "critical";
  if (label === "Ext. Humidity") return value < 90 ? "nominal" : "warning";
  if (label === "Radiation") return value < 50 ? "nominal" : value < 200 ? "warning" : "critical";
  if (label === "Heater") return value > 0 ? "warning" : "nominal";
  return "nominal";
}

function TelemetryCard({ label, value, unit, decimals = 2 }: {
  label: string; value: number; unit: string; decimals?: number;
}) {
  const status = getStatus(label, value);
  const display = Math.abs(value) > 9999 ? value.toFixed(0) : value.toFixed(decimals);
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">{label}</span>
        <StatusDot status={status} />
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-2xl font-bold text-foreground">{display}</span>
        <span className="text-sm text-muted-foreground font-mono">{unit}</span>
      </div>
    </div>
  );
}


export default function TelemetryPage() {
  const { telemetry: sim } = useLiveData();

  const halowColor =
    sim.halowStatus === "ACTIVE" ? "text-success"
    : sim.halowStatus === "DEGRADED" ? "text-warning"
    : "text-destructive";
  const halowBg =
    sim.halowStatus === "ACTIVE" ? "bg-success"
    : sim.halowStatus === "DEGRADED" ? "bg-warning"
    : "bg-destructive";
  const halowBorder =
    sim.halowStatus === "ACTIVE" ? "border-success/30"
    : sim.halowStatus === "DEGRADED" ? "border-warning/30"
    : "border-destructive/30";

  const errorBits = sim.errorFlags
    ? Array.from({ length: 8 }, (_, i) => (sim.errorFlags >> i) & 1)
        .map((b, i) => (b ? `ERR[${i}]` : null))
        .filter(Boolean)
        .join(" ")
    : null;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* HaLow Status Banner */}
      <div className={`rounded-lg border ${halowBorder} bg-card p-4 flex items-center justify-between flex-wrap gap-4`}>
        <div className="flex items-center gap-3">
          <div className={`h-3 w-3 rounded-full ${halowBg} animate-pulse-glow`} />
          <span className="font-mono text-sm text-muted-foreground">Wi-Fi HaLow Link</span>
          <span className={`font-mono text-lg font-bold ${halowColor}`}>{sim.halowStatus}</span>
        </div>
        <div className="flex gap-6 flex-wrap">
          <Stat label="RSSI" value={`${sim.rssi.toFixed(1)} dBm`} />
          <Stat label="SNR" value={`${sim.snr.toFixed(1)} dB`} />
          <Stat label="PDR" value={`${sim.successRate}%`} />
          <Stat label="Noise Floor" value={`${sim.noiseFloor.toFixed(1)} dBm`} />
          <Stat label="MCS" value={`${sim.txMcs}`} />
          <Stat label="Freq Dev" value={`${sim.freqDevHz} Hz`} />
        </div>
      </div>

      {/* Telemetry Grid */}
      <div>
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-3">GNSS / Environment</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <TelemetryCard label="Latitude" value={sim.latitude} unit="°" decimals={5} />
          <TelemetryCard label="Longitude" value={sim.longitude} unit="°" decimals={5} />
          <TelemetryCard label="Altitude" value={sim.altitude} unit="m" decimals={0} />
          <TelemetryCard label="Int. Temp" value={sim.intTempC} unit="°C" />
          <TelemetryCard label="Ext. Temp" value={sim.extTempC} unit="°C" />
          <TelemetryCard label="Ext. Humidity" value={sim.extHumidityRh} unit="%" />
        </div>
      </div>

      <div>
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-3">Hardware / Power</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          <TelemetryCard label="RF Volt" value={sim.rfVoltMv} unit="mV" decimals={0} />
          <TelemetryCard label="HaLow I" value={sim.halowCurrMa} unit="mA" decimals={0} />
          <TelemetryCard label="Chip Temp" value={sim.chipTempC} unit="°C" decimals={0} />
          <TelemetryCard label="Heater" value={sim.heaterPower} unit="%" decimals={2} />
          <TelemetryCard label="Pressure" value={sim.pressurePa} unit="Pa" decimals={0} />
          <TelemetryCard label="Radiation" value={sim.radiationCps} unit="cps" decimals={0} />
        </div>
      </div>

      {/* GNSS + Error status */}
      <div className="flex gap-4 flex-wrap">
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex items-center gap-3">
          <div className={`h-2.5 w-2.5 rounded-full ${sim.gpsFix ? "bg-success" : "bg-destructive"}`} />
          <span className="font-mono text-xs text-muted-foreground">GPS Fix</span>
          <span className="font-mono text-sm text-foreground">{sim.gpsFix ? `YES (${sim.gpsSats} sats)` : "NO FIX"}</span>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">Packets RX</span>
          <span className="font-mono text-sm text-foreground">{sim.packetCount}</span>
        </div>
        {errorBits && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 flex items-center gap-3">
            <span className="font-mono text-xs text-destructive">{errorBits}</span>
          </div>
        )}
      </div>

      {/* RSSI + SNR chart */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="font-mono text-sm text-muted-foreground mb-4 uppercase tracking-wider">RF Link Quality</h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={sim.rssiHistory}>
            <CartesianGrid strokeDasharray="3 3" stroke="#28808D33" />
            <XAxis dataKey="time" tick={{ fill: "#E1DFB4aa", fontSize: 11, fontFamily: "JetBrains Mono" }} tickFormatter={(v) => `${v}s`} />
            <YAxis yAxisId="rssi" domain={[-110, -30]} tick={{ fill: "#E1DFB4aa", fontSize: 11, fontFamily: "JetBrains Mono" }} />
            <YAxis yAxisId="snr" orientation="right" domain={[0, 40]} tick={{ fill: "#E1DFB4aa", fontSize: 11, fontFamily: "JetBrains Mono" }} />
            <Tooltip contentStyle={{ background: "#183054", border: "1px solid #28808D", fontFamily: "JetBrains Mono", fontSize: 12, color: "#E1DFB4" }} labelFormatter={(v) => `T+${v}s`} />
            <Legend wrapperStyle={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "#E1DFB4aa" }} />
            <Line yAxisId="rssi" type="monotone" dataKey="rssi" stroke="#28808D" strokeWidth={2} dot={false} name="RSSI (dBm)" />
            <Line yAxisId="snr" type="monotone" dataKey="snr" stroke="#A5BB86" strokeWidth={2} dot={false} name="SNR (dB)" />
          </LineChart>
        </ResponsiveContainer>
      </div>

    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-semibold text-foreground">{value}</span>
    </div>
  );
}
