import { useEffect, useMemo, useState } from "react";
import { useLiveData } from "@/hooks/useLiveData";
import {
  buildGroundRadioSeries,
  buildPayloadRadioSeries,
  downsample,
  groundSpeedKmh,
  packetIntervals,
  seriesStats,
  verticalSpeed,
  windowed,
} from "@/lib/telemetrySeries";
import ChartCard from "@/components/telemetry/ChartCard";
import ErrorStrips from "@/components/telemetry/ErrorStrips";
import TimeSeriesChart, { type ChartRow, type SeriesSpec } from "@/components/telemetry/TimeSeriesChart";
import { CHART_COLORS } from "@/components/telemetry/chartTheme";

const WINDOWS: { label: string; ms: number | null }[] = [
  { label: "5 min", ms: 5 * 60_000 },
  { label: "30 min", ms: 30 * 60_000 },
  { label: "2 h", ms: 2 * 3600_000 },
  { label: "All", ms: null },
];

const SYNC = "telemetry";
const MAX_POINTS = 900;
/** Sensitivity of the HaLow receiver at the lowest MCS, for reference on the RSSI chart. */
const RSSI_SENSITIVITY_DBM = -107;

const STATE_NAMES: Record<number, string> = {
  0: "Boot", 1: "Idle", 2: "Ground", 3: "Ascent", 4: "Float", 5: "Descent", 6: "Landed",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h2 className="font-mono text-xs uppercase tracking-[0.25em] text-primary">{title}</h2>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{children}</div>
    </div>
  );
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export default function TelemetryChartsPage() {
  const { elinkSamples, gsRfSamples } = useLiveData();
  const [windowMs, setWindowMs] = useState<number | null>(30 * 60_000);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const samples = useMemo(() => windowed(elinkSamples, windowMs), [elinkSamples, windowMs]);
  const dumps = useMemo(() => {
    const from = samples.length > 0 ? samples[0].t : null;
    return from === null ? [] : gsRfSamples.filter((d) => d.t >= from);
  }, [gsRfSamples, samples]);

  const view = useMemo(() => {
    const vs = verticalSpeed(samples);
    const gs = groundSpeedKmh(samples);
    const dt = packetIntervals(samples);
    const rows = samples.map((s, i) => ({
      t: s.t,
      alt: s.alt,
      vspeed: vs[i],
      gspeed: gs[i],
      sats: s.sats,
      pressure: s.pressurePa === null ? null : s.pressurePa / 100,
      extTemp: s.extTempC,
      intTemp: s.intTempC,
      humidity: s.humidity,
      radiation: s.radiationCps,
      halowCurr: s.halowCurrMa,
      chipTemp: s.chipTempC,
      heater: s.heaterPower,
      interval: dt[i],
      pdr: s.pdr,
      mcs: s.mcs,
      state: s.state,
    }));
    // one series per provider: what the payload measured, and what the ground module measured
    const payloadRadio = buildPayloadRadioSeries(samples);
    const groundRadio = buildGroundRadioSeries(samples, dumps);
    return {
      rows: downsample(rows, MAX_POINTS) as ChartRow[],
      raw: rows,
      payloadRadio: downsample(payloadRadio, MAX_POINTS) as unknown as ChartRow[],
      payloadRadioRaw: payloadRadio,
      groundRadio: downsample(groundRadio, MAX_POINTS) as unknown as ChartRow[],
      groundRadioRaw: groundRadio,
      moduleRows: downsample(
        dumps.map((d) => ({ t: d.t, chip: d.chipTempC, vcc: d.vcc, per: d.txPerPct, mcs: d.txMcs, kbps: d.rxKbps })),
        MAX_POINTS,
      ) as ChartRow[],
      moduleRaw: dumps,
    };
  }, [samples, dumps]);

  const stat = (key: keyof (typeof view.raw)[number]) => seriesStats(view.raw.map((r) => r[key] as number | null));
  const payloadStat = (key: "rssi" | "snr" | "noiseFloor" | "freqDevHz") =>
    seriesStats(view.payloadRadioRaw.map((r) => r[key]));
  const groundStat = (key: "rssi" | "snr" | "noiseFloor" | "freqDevHz") =>
    seriesStats(view.groundRadioRaw.map((r) => r[key]));
  const lastSample = elinkSamples[elinkSamples.length - 1];
  const lastAge = lastSample ? now - lastSample.t : null;
  const live = lastAge !== null && lastAge < 10_000;

  const one = (key: string, label: string, color: string, extra: Partial<SeriesSpec> = {}): SeriesSpec[] => [
    { key, label, color, ...extra },
  ];

  return (
    <div className="space-y-8 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-bold tracking-wider text-foreground">Telemetría</h1>
          <p className="mt-1 flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <span className={`inline-block h-2 w-2 rounded-full ${live ? "bg-success animate-pulse-glow" : "bg-muted-foreground/40"}`} />
            {lastAge === null
              ? "No E-Link packets yet"
              : `${live ? "Live" : "Stale"} · last E-Link packet ${ago(lastAge)} · ${samples.length} packets in view`}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border bg-card p-1" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              onClick={() => setWindowMs(w.ms)}
              aria-pressed={windowMs === w.ms}
              className={`rounded-md px-3 py-1.5 font-mono text-xs transition-all ${
                windowMs === w.ms
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <Section title="Flight">
        <ChartCard title="Altitude" unit="m" decimals={0} stats={stat("alt")} color={CHART_COLORS.blue} badge="GNSS">
          <TimeSeriesChart data={view.rows} series={one("alt", "Altitude", CHART_COLORS.blue, { unit: "m", decimals: 0 })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Vertical speed" unit="m/s" stats={stat("vspeed")} color={CHART_COLORS.teal} badge="derived">
          <TimeSeriesChart data={view.rows} series={one("vspeed", "Vertical speed", CHART_COLORS.teal, { unit: "m/s" })} references={[{ y: 0, label: "0" }]} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Ground speed" unit="km/h" stats={stat("gspeed")} color={CHART_COLORS.violet} badge="derived">
          <TimeSeriesChart data={view.rows} series={one("gspeed", "Ground speed", CHART_COLORS.violet, { unit: "km/h" })} yDomain={undefined} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="GNSS satellites" decimals={0} stats={stat("sats")} color={CHART_COLORS.green} badge="GNSS">
          <TimeSeriesChart data={view.rows} series={one("sats", "Satellites", CHART_COLORS.green, { decimals: 0, kind: "step" })} syncId={SYNC} />
        </ChartCard>
      </Section>

      <Section title="Radio link">
        <p className="xl:col-span-2 font-mono text-xs text-muted-foreground">
          Each end of the link measures the frames it receives from the other, so every figure has two readings:
          the payload's (the ground station's frames, as the payload sees them) and the ground module's (the payload's
          frames). Transmit powers, antennas and receivers differ, so the values differ. Each chart has one provider
          and nothing fills the other's gaps.
        </p>
        <ChartCard title="RSSI · payload" unit="dBm" stats={payloadStat("rssi")} color={CHART_COLORS.teal} badge="payload"
          emptyMessage="The payload reports no RSSI (it sends 0 when it has no reading)">
          <TimeSeriesChart data={view.payloadRadio} series={one("rssi", "RSSI (payload)", CHART_COLORS.teal, { unit: "dBm" })}
            references={[{ y: RSSI_SENSITIVITY_DBM, label: "sensitivity", color: CHART_COLORS.coral }]} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="RSSI · ground station" unit="dBm" stats={groundStat("rssi")} color={CHART_COLORS.amber} badge="ground module"
          emptyMessage="No RSSI yet — waiting for the ground module's status dump">
          <TimeSeriesChart data={view.groundRadio} series={one("rssi", "RSSI (ground)", CHART_COLORS.amber, { unit: "dBm" })}
            references={[{ y: RSSI_SENSITIVITY_DBM, label: "sensitivity", color: CHART_COLORS.coral }]} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="SNR · payload" unit="dB" stats={payloadStat("snr")} color={CHART_COLORS.teal} badge="payload"
          emptyMessage="The payload reports no SNR (it sends 0 when it has no reading)">
          <TimeSeriesChart data={view.payloadRadio} series={one("snr", "SNR (payload)", CHART_COLORS.teal, { unit: "dB" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="SNR · ground station" unit="dB" stats={groundStat("snr")} color={CHART_COLORS.amber} badge="ground module"
          emptyMessage="No SNR yet — waiting for the ground module's status dump">
          <TimeSeriesChart data={view.groundRadio} series={one("snr", "SNR (ground)", CHART_COLORS.amber, { unit: "dB" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Noise floor · payload" unit="dBm" stats={payloadStat("noiseFloor")} color={CHART_COLORS.teal} badge="payload"
          emptyMessage="The payload reports no noise floor (it sends 0 when it has no reading)">
          <TimeSeriesChart data={view.payloadRadio} series={one("noiseFloor", "Noise floor (payload)", CHART_COLORS.teal, { unit: "dBm" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Noise floor · ground station" unit="dBm" stats={groundStat("noiseFloor")} color={CHART_COLORS.amber} badge="ground module"
          emptyMessage="No noise floor yet — waiting for the ground module's status dump">
          <TimeSeriesChart data={view.groundRadio} series={one("noiseFloor", "Noise floor (ground)", CHART_COLORS.amber, { unit: "dBm" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Frequency deviation · payload" unit="Hz" decimals={0} stats={payloadStat("freqDevHz")} color={CHART_COLORS.teal} badge="payload"
          emptyMessage="The payload reports no frequency deviation (it sends 0 when it has no reading)">
          <TimeSeriesChart data={view.payloadRadio} series={one("freqDevHz", "Frequency deviation (payload)", CHART_COLORS.teal, { unit: "Hz", decimals: 0 })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Frequency deviation · ground station" unit="Hz" decimals={0} stats={groundStat("freqDevHz")} color={CHART_COLORS.amber} badge="ground module"
          emptyMessage="No frequency deviation yet — waiting for the ground module's status dump">
          <TimeSeriesChart data={view.groundRadio} series={one("freqDevHz", "Frequency deviation (ground)", CHART_COLORS.amber, { unit: "Hz", decimals: 0 })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Packet delivery rate · payload" unit="%" decimals={0} stats={stat("pdr")} color={CHART_COLORS.teal} badge="payload">
          <TimeSeriesChart data={view.rows} series={one("pdr", "Success rate", CHART_COLORS.teal, { unit: "%", decimals: 0 })} yDomain={[0, 100]} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Packet error rate · ground station" unit="%" decimals={0} stats={seriesStats(view.moduleRaw.map((d) => d.txPerPct))}
          color={CHART_COLORS.amber} badge="ground module" emptyMessage="Waiting for the ground module's status dump">
          <TimeSeriesChart data={view.moduleRows} series={one("per", "Error rate", CHART_COLORS.amber, { unit: "%", decimals: 0 })} yDomain={[0, 100]} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="TX MCS · payload" decimals={0} stats={stat("mcs")} color={CHART_COLORS.teal} badge="payload">
          <TimeSeriesChart data={view.rows} series={one("mcs", "MCS", CHART_COLORS.teal, { decimals: 0, kind: "step" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="TX MCS · ground station" decimals={0} stats={seriesStats(view.moduleRaw.map((d) => d.txMcs))}
          color={CHART_COLORS.amber} badge="ground module" emptyMessage="Waiting for the ground module's status dump">
          <TimeSeriesChart data={view.moduleRows} series={one("mcs", "MCS", CHART_COLORS.amber, { decimals: 0, kind: "step" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Ground module chip temperature" unit="°C" stats={seriesStats(view.moduleRaw.map((d) => d.chipTempC))}
          color={CHART_COLORS.coral} badge="ground module" emptyMessage="Waiting for the ground module's status dump">
          <TimeSeriesChart data={view.moduleRows} series={one("chip", "Chip", CHART_COLORS.coral, { unit: "°C" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Ground module supply" unit="V" decimals={2} stats={seriesStats(view.moduleRaw.map((d) => d.vcc))}
          color={CHART_COLORS.amber} badge="ground module" emptyMessage="Waiting for the ground module's status dump">
          <TimeSeriesChart data={view.moduleRows} series={one("vcc", "VCC", CHART_COLORS.amber, { unit: "V", decimals: 2 })} syncId={SYNC} />
        </ChartCard>
      </Section>

      <Section title="Environment">
        <ChartCard title="Pressure" unit="hPa" stats={stat("pressure")} color={CHART_COLORS.blue}>
          <TimeSeriesChart data={view.rows} series={one("pressure", "Pressure", CHART_COLORS.blue, { unit: "hPa" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard
          title="Temperature" unit="°C" stats={stat("extTemp")} color={CHART_COLORS.teal}
          legend={[{ label: "External", color: CHART_COLORS.teal }, { label: "Internal", color: CHART_COLORS.amber }]}
        >
          <TimeSeriesChart
            data={view.rows}
            series={[
              { key: "extTemp", label: "External", color: CHART_COLORS.teal, unit: "°C", kind: "line" },
              { key: "intTemp", label: "Internal", color: CHART_COLORS.amber, unit: "°C", kind: "line" },
            ]}
            syncId={SYNC}
          />
        </ChartCard>
        <ChartCard title="External humidity" unit="%" stats={stat("humidity")} color={CHART_COLORS.sky}>
          <TimeSeriesChart data={view.rows} series={one("humidity", "Humidity", CHART_COLORS.sky, { unit: "%" })} yDomain={[0, 100]} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Radiation" unit="cps" stats={stat("radiation")} color={CHART_COLORS.rose}>
          <TimeSeriesChart data={view.rows} series={one("radiation", "Radiation", CHART_COLORS.rose, { unit: "cps", kind: "step" })} syncId={SYNC} />
        </ChartCard>
      </Section>

      <Section title="Power & thermal">
        <ChartCard title="HaLow current" unit="mA" decimals={0} stats={stat("halowCurr")} color={CHART_COLORS.amber} badge="payload">
          <TimeSeriesChart data={view.rows} series={one("halowCurr", "Current", CHART_COLORS.amber, { unit: "mA", decimals: 0 })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="HaLow chip temperature" unit="°C" stats={stat("chipTemp")} color={CHART_COLORS.coral} badge="payload">
          <TimeSeriesChart data={view.rows} series={one("chipTemp", "Chip", CHART_COLORS.coral, { unit: "°C" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="Heater power" unit="%" decimals={0} stats={stat("heater")} color={CHART_COLORS.rose}>
          <TimeSeriesChart data={view.rows} series={one("heater", "Heater", CHART_COLORS.rose, { unit: "%", decimals: 0, kind: "step" })} syncId={SYNC} />
        </ChartCard>
        <ChartCard title="System state" decimals={0} stats={stat("state")} color={CHART_COLORS.violet}
          badge={lastSample?.state != null ? (STATE_NAMES[lastSample.state] ?? `state ${lastSample.state}`) : undefined}>
          <TimeSeriesChart data={view.rows} series={one("state", "State", CHART_COLORS.violet, { decimals: 0, kind: "step" })} syncId={SYNC} />
        </ChartCard>
      </Section>

      <Section title="Link health">
        <ChartCard title="Packet interval" unit="s" stats={stat("interval")} color={CHART_COLORS.teal} badge="E-Link">
          <TimeSeriesChart data={view.rows} series={one("interval", "Interval", CHART_COLORS.teal, { unit: "s" })} yDomain={undefined} syncId={SYNC} />
        </ChartCard>
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <h3 className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Sensor error flags</h3>
          {samples.length === 0 ? (
            <div className="flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border/70 font-mono text-xs text-muted-foreground">
              Waiting for data
            </div>
          ) : (
            <ErrorStrips samples={samples} />
          )}
        </section>
      </Section>
    </div>
  );
}
