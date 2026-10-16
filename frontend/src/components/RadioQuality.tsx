import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import type { TelemetryData } from "@/hooks/useLiveData";
import { fmt } from "@/lib/format";

/**
 * The two measurements of the HaLow link, side by side and never merged. The payload
 * measures the ground station's frames; the ground station's module measures the
 * payload's. Different transmit powers, antennas and receivers: the numbers differ.
 */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-semibold text-foreground">{value}</span>
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-3 space-y-2">
      <div>
        <p className="font-mono text-xs font-semibold text-foreground uppercase tracking-wider">{title}</p>
        <p className="font-mono text-[11px] text-muted-foreground/70">{hint}</p>
      </div>
      <div className="flex gap-6 flex-wrap">{children}</div>
    </div>
  );
}

/** Current RSSI, SNR, noise floor and frequency deviation, one group per provider. */
export function RadioStatGroups({ d }: { d: TelemetryData }) {
  return (
    <div className="basis-full grid gap-3 md:grid-cols-2">
      <Group title="Payload" hint="frames of the ground station, received by the payload">
        <Stat label="RSSI" value={fmt(d.rssi, 1, "dBm")} />
        <Stat label="SNR" value={fmt(d.snr, 1, "dB")} />
        <Stat label="Noise Floor" value={fmt(d.noiseFloor, 1, "dBm")} />
        <Stat label="Freq Dev" value={fmt(d.freqDevHz, 0, "Hz")} />
      </Group>
      <Group title="Ground station" hint="frames of the payload, received by the ground module">
        <Stat label="RSSI" value={fmt(d.gsRssi, 1, "dBm")} />
        <Stat label="SNR" value={fmt(d.gsSnr, 1, "dB")} />
        <Stat label="Noise Floor" value={fmt(d.gsNoiseFloor, 1, "dBm")} />
        <Stat label="Freq Dev" value={fmt(d.gsFreqDev, 0, "Hz")} />
      </Group>
    </div>
  );
}

const AXIS = { fill: "#E1DFB4aa", fontSize: 11, fontFamily: "JetBrains Mono" } as const;

type History = { time: number; rssi: number; snr: number | null }[];

function RfChart({
  title, hint, data, rssiColor, snrColor, empty,
}: { title: string; hint: string; data: History; rssiColor: string; snrColor: string; empty: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="font-mono text-sm text-muted-foreground uppercase tracking-wider">{title}</h3>
      <p className="font-mono text-[11px] text-muted-foreground/70 mb-3">{hint}</p>
      {data.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center rounded-lg border border-dashed border-border/70 px-4 text-center font-mono text-xs text-muted-foreground">
          {empty}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#28808D33" />
            <XAxis dataKey="time" tick={AXIS} tickFormatter={(v) => `${v}s`} />
            <YAxis yAxisId="rssi" domain={[-110, -30]} tick={AXIS} />
            <YAxis yAxisId="snr" orientation="right" domain={[0, 40]} tick={AXIS} />
            <Tooltip
              contentStyle={{ background: "#183054", border: "1px solid #28808D", fontFamily: "JetBrains Mono", fontSize: 12, color: "#E1DFB4" }}
              labelFormatter={(v) => `T+${v}s`}
            />
            <Legend wrapperStyle={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "#E1DFB4aa" }} />
            <Line yAxisId="rssi" type="monotone" dataKey="rssi" stroke={rssiColor} strokeWidth={2} dot={false} name="RSSI (dBm)" connectNulls />
            <Line yAxisId="snr" type="monotone" dataKey="snr" stroke={snrColor} strokeWidth={2} dot={false} name="SNR (dB)" connectNulls />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** Two charts, one per provider: what the payload measured, and what the ground station measured. */
export function RfLinkCharts({ d, link }: { d: TelemetryData; link: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <RfChart
        title={`RF link quality · payload (${link})`}
        hint="Measured by the payload on the ground station's frames."
        data={d.rssiHistory}
        rssiColor="#28808D"
        snrColor="#A5BB86"
        empty="The payload is reporting no RSSI (it sends 0 when it has no reading)."
      />
      <RfChart
        title={`RF link quality · ground station (${link})`}
        hint="Measured by the ground module on the payload's frames."
        data={d.gsRssiHistory}
        rssiColor="#E0A030"
        snrColor="#6FB1E0"
        empty="No ground-module reading yet (it needs the module's status dump, AT+SYSDBG=LMAC,1)."
      />
    </div>
  );
}
