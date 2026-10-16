import { useState } from "react";
import { useLiveData } from "@/hooks/useLiveData";
import CommandModal from "@/components/CommandModal";
import { RadioStatGroups, RfLinkCharts } from "@/components/RadioQuality";
import { decodeTelemetryErrors } from "@/lib/telemetryErrors";
import { fmt } from "@/lib/format";

function StatusDot({ status }: { status: "nominal" | "warning" | "critical" | "idle" }) {
  const cls =
    status === "nominal" ? "bg-success"
    : status === "warning" ? "bg-warning"
    : status === "critical" ? "bg-destructive"
    : "bg-muted-foreground/40";
  return <div className={`h-2.5 w-2.5 rounded-full ${cls}`} />;
}

function getStatus(label: string, value: number): "nominal" | "warning" | "critical" {
  if (label === "RSSI") return value > -70 ? "nominal" : value > -85 ? "warning" : "critical";
  if (label === "SNR") return value > 15 ? "nominal" : value > 5 ? "warning" : "critical";
  if (label === "Int. Temp") return value > 10 && value < 35 ? "nominal" : "warning";
  if (label === "Ext. Temp") return value > -40 ? "nominal" : value > -55 ? "warning" : "critical";
  if (label === "Chip Temp") return value < 70 ? "nominal" : value < 85 ? "warning" : "critical";
  if (label === "Ext. Humidity") return value < 90 ? "nominal" : "warning";
  if (label === "Radiation") return value < 50 ? "nominal" : value < 200 ? "warning" : "critical";
  if (label === "Heater") return value > 0 ? "warning" : "nominal";
  return "nominal";
}

function TelemetryCard({ label, value, unit, decimals = 2 }: {
  label: string; value: number | null; unit: string; decimals?: number;
}) {
  const status = value === null ? "idle" : getStatus(label, value);
  const display = fmt(value, decimals);
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-semibold text-foreground">{value}</span>
    </div>
  );
}

export default function ELinkPage() {
  const { elinkTelemetry: d, connection } = useLiveData();
  const [cmdOpen, setCmdOpen] = useState(false);

  const linkColor = connection.elinkConnected ? "text-success" : connection.elinkReady ? "text-warning" : "text-destructive";
  const linkBg = connection.elinkConnected ? "bg-success" : connection.elinkReady ? "bg-warning" : "bg-destructive";
  const linkBorder = connection.elinkConnected ? "border-success/30" : connection.elinkReady ? "border-warning/30" : "border-destructive/30";

  const halowColor =
    d.halowStatus === "ACTIVE" ? "text-success"
    : d.halowStatus === "DEGRADED" ? "text-warning"
    : d.halowStatus === "INTERRUPTED" ? "text-destructive"
    : "text-muted-foreground";
  const halowBg =
    d.halowStatus === "ACTIVE" ? "bg-success"
    : d.halowStatus === "DEGRADED" ? "bg-warning"
    : d.halowStatus === "INTERRUPTED" ? "bg-destructive"
    : "bg-muted-foreground/40";
  const halowBorder =
    d.halowStatus === "ACTIVE" ? "border-success/30"
    : d.halowStatus === "DEGRADED" ? "border-warning/30"
    : d.halowStatus === "INTERRUPTED" ? "border-destructive/30"
    : "border-border";

  const errorBits = decodeTelemetryErrors(d.errorFlags);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* E-Link connection status */}
      <div className={`rounded-lg border ${linkBorder} bg-card p-4 flex items-center justify-between flex-wrap gap-4`}>
        <div className="flex items-center gap-3">
          <div className={`h-3 w-3 rounded-full ${linkBg} ${connection.elinkConnected ? "animate-pulse-glow" : ""}`} />
          <span className="font-mono text-sm text-muted-foreground">E-Link UDP</span>
          <span className={`font-mono text-lg font-bold ${linkColor}`}>
            {connection.elinkConnected ? "PAYLOAD ONLINE" : connection.elinkReady ? "UDP READY · PAYLOAD OFFLINE" : "NOT READY"}
          </span>
          {connection.elinkPort && connection.elinkPort !== "—" && (
            <span className="font-mono text-xs text-muted-foreground">{connection.elinkPort}</span>
          )}
        </div>
        <button
          onClick={() => setCmdOpen(true)}
          className="px-4 py-2 rounded font-mono text-xs border border-primary/40 text-primary hover:bg-primary/10 transition-all"
        >
          Open Command Panel
        </button>
      </div>

      {/* This tab only listens to E-Link: when it goes quiet nothing here refreshes */}
      {!connection.elinkFresh && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
          {d.receivedAt === null
            ? "No E-Link packets received yet."
            : `No E-Link packets for a while — showing the last values, received at ${new Date(d.receivedAt).toLocaleTimeString([], { hour12: false })}.`}
        </div>
      )}

      {/* HaLow link status from E-Link telemetry */}
      <div className={`rounded-lg border ${halowBorder} bg-card p-4 flex items-center justify-between flex-wrap gap-4`}>
        <div className="flex items-center gap-3">
          <div className={`h-3 w-3 rounded-full ${halowBg}`} />
          <span className="font-mono text-sm text-muted-foreground">HaLow Link (vía E-Link)</span>
          <span className={`font-mono text-lg font-bold ${halowColor}`}>{d.halowStatus ?? "NO DATA"}</span>
        </div>
        <div className="flex gap-6 flex-wrap">
          <Stat label="PDR" value={fmt(d.successRate, 0, "%")} />
          <Stat label="MCS" value={fmt(d.txMcs, 0)} />
        </div>
        <RadioStatGroups d={d} />
        <p className="basis-full font-mono text-[11px] text-muted-foreground/70">
          Two different measurements, each end on the other's frames: they differ by design and are never merged.
          A blank is a missing reading, not a zero.
        </p>
      </div>

      {/* GNSS / Environment */}
      <div>
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-3">GNSS / Environment</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <TelemetryCard label="Latitude"     value={d.latitude}       unit="°"  decimals={5} />
          <TelemetryCard label="Longitude"    value={d.longitude}      unit="°"  decimals={5} />
          <TelemetryCard label="Altitude"     value={d.altitude}       unit="m"  decimals={0} />
          <TelemetryCard label="Int. Temp"    value={d.intTempC}       unit="°C" />
          <TelemetryCard label="Ext. Temp"    value={d.extTempC}       unit="°C" />
          <TelemetryCard label="Ext. Humidity" value={d.extHumidityRh} unit="%" />
        </div>
      </div>

      {/* Hardware / Power */}
      <div>
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-wider mb-3">Hardware / Power</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <TelemetryCard label="System State" value={d.systemState} unit={d.systemStateLabel ?? ""} decimals={0} />
          <TelemetryCard label="HaLow I"   value={d.halowCurrMa}  unit="mA"  decimals={0} />
          <TelemetryCard label="Chip Temp" value={d.chipTempC}     unit="°C"  decimals={0} />
          <TelemetryCard label="Heater"    value={d.heaterPower}   unit="%"   decimals={2} />
          <TelemetryCard label="Pressure"  value={d.pressurePa}    unit="Pa"  decimals={0} />
          <TelemetryCard label="Radiation" value={d.radiationCps}  unit="cps" decimals={0} />
        </div>
      </div>

      {/* Status row */}
      <div className="flex gap-4 flex-wrap">
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex items-center gap-3">
          <div className={`h-2.5 w-2.5 rounded-full ${d.gpsFix === null ? "bg-muted-foreground/40" : d.gpsFix ? "bg-success" : "bg-destructive"}`} />
          <span className="font-mono text-xs text-muted-foreground">GPS Fix</span>
          <span className="font-mono text-sm text-foreground">{d.gpsFix === null ? "—" : d.gpsFix ? `YES (${d.gpsSats} sats)` : "NO FIX"}</span>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3 flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">Packets RX</span>
          <span className="font-mono text-sm text-foreground">{fmt(d.packetCount, 0)}</span>
        </div>
        {errorBits && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 flex items-center gap-3">
            <span className="font-mono text-xs text-destructive">{errorBits}</span>
          </div>
        )}
      </div>

      {/* RF charts: one per provider */}
      <RfLinkCharts d={d} link="E-Link" />

      <CommandModal open={cmdOpen} onClose={() => setCmdOpen(false)} />
    </div>
  );
}
