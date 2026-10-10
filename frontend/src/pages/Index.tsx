import { useNavigate } from "react-router-dom";
import { useLiveData } from "@/hooks/useLiveData";
import { fmt, LINK_MODE_LABEL } from "@/lib/format";

export default function Index() {
  const navigate = useNavigate();
  const { connection, telemetry } = useLiveData();
  const receiving = connection.mode !== "none";

  return (
    <div className="relative min-h-[calc(100vh-57px)] flex flex-col items-center justify-center overflow-hidden">

      {/* Hero background from Higgsfield */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url(/assets/hero_gs_1.png)" }}
      />
      {/* Overlay to keep BLESS palette readable */}
      <div className="absolute inset-0 bg-[#0d1f38]/75" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-8 px-6 text-center max-w-2xl">

        {/* Pulsing antenna icon */}
        <div className="relative flex items-center justify-center w-8 h-8">
          <div className="absolute h-8 w-8 rounded-full bg-primary/30 animate-ping" />
          <div className="h-4 w-4 rounded-full bg-primary animate-pulse-glow" />
        </div>

        {/* Title */}
        <div className="space-y-2">
          <p className="font-mono text-xs text-primary/70 uppercase tracking-[0.3em]">BEXUS 38 — UFV Spain</p>
          <h1 className="font-mono text-5xl font-bold text-primary text-glow-primary tracking-wider">
            BLESS
          </h1>
          <p className="font-mono text-sm text-muted-foreground tracking-wider">
            BEXUS HaLow Evaluation in Stratospheric Systems
          </p>
        </div>

        {/* Connection status pill */}
        <div className={`flex items-center gap-2 border rounded-full px-5 py-2 ${
          receiving
            ? "border-success/40 bg-success/10"
            : "border-warning/40 bg-warning/10"
        }`}>
          <div className={`h-2 w-2 rounded-full ${receiving ? "bg-success animate-pulse" : "bg-warning"}`} />
          <span className={`font-mono text-xs font-semibold ${receiving ? "text-success" : "text-warning"}`}>
            {receiving
              ? `${LINK_MODE_LABEL[connection.mode]} · ${fmt(telemetry.packetCount, 0)} packets RX`
              : connection.wsConnected
                ? "WAITING FOR PACKETS"
                : "BACKEND NOT CONNECTED"}
          </span>
        </div>

        {/* CTA buttons */}
        <div className="flex gap-4 flex-wrap justify-center">
          <button
            onClick={() => navigate("/telemetry")}
            className="px-8 py-3 rounded-lg bg-primary/20 border border-primary/40 font-mono text-sm font-semibold text-primary hover:bg-primary/30 transition-all text-glow-primary"
          >
            → HaLow Telemetry
          </button>
          <button
            onClick={() => navigate("/map")}
            className="px-8 py-3 rounded-lg bg-secondary/20 border border-secondary/40 font-mono text-sm font-semibold text-secondary hover:bg-secondary/30 transition-all"
          >
            → Map & Tracking
          </button>
          <button
            onClick={() => navigate("/antenna")}
            className="px-8 py-3 rounded-lg bg-tertiary/20 border border-tertiary/40 font-mono text-sm font-semibold text-tertiary hover:bg-tertiary/30 transition-all"
          >
            → Antenna Pointing
          </button>
        </div>

        {/* Subtitle */}
        <p className="font-mono text-xs text-muted-foreground/60 max-w-md">
          IEEE 802.11ah · 868 MHz · Morse Micro MM6108 · Esrange Space Center
        </p>
      </div>

      {/* Bottom fade */}
      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent" />
    </div>
  );
}
