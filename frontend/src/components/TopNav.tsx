import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useLiveData } from "@/hooks/useLiveData";
import { useMissionClock } from "@/hooks/useMissionClock";
import { LINK_MODE_LABEL } from "@/lib/format";
import { missionClockParts } from "@/lib/missionClock";
import MissionClockModal from "./MissionClockModal";
import SettingsModal from "./SettingsModal";

const navItems = [
  { to: "/telemetry", label: "HaLow" },
  { to: "/elink", label: "E-Link" },
  { to: "/map", label: "Map & Tracking" },
  { to: "/antenna", label: "Antenna Pointing" },
];

export default function TopNav() {
  const { telemetry, connection, logging, toggleLogging } = useLiveData();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  const missionClock = useMissionClock();

  // Mission clock: set by the operator, independent of incoming packets.
  const clockParts = missionClock.offsetMs === null ? null : missionClockParts(missionClock.offsetMs);
  const countingDown = clockParts?.sign === "-";

  // Payload uptime (ms since boot) is only shown for reference inside the clock dialog.
  let payloadUptime: string | null = null;
  if (telemetry.timestamp !== null) {
    const elapsed = Math.floor(telemetry.timestamp / 1000);
    const h = Math.floor(elapsed / 3600).toString().padStart(2, "0");
    const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, "0");
    const s = (elapsed % 60).toString().padStart(2, "0");
    payloadUptime = `${h}:${m}:${s}`;
  }

  return (
    <>
      <nav className="flex items-center justify-between border-b border-border bg-card px-6 py-3 gap-4">
        {/* Logo */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-3 w-3 rounded-full bg-primary animate-pulse-glow" />
          <span className="font-mono text-lg font-bold text-primary text-glow-primary tracking-wider">
            BLESS Mission Control
          </span>
        </div>

        <div className="flex items-center gap-4">
          {/* Nav links */}
          <div className="flex gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `px-4 py-2 rounded-md font-mono text-sm transition-all ${
                    isActive
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>

          {/* Connection status — click to open settings */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2 border border-border/60 rounded-lg px-3 py-1.5 hover:bg-muted/40 transition-all group"
            title="Configure serial port"
          >
            {connection.mode !== "none" ? (
              <>
                <div className="h-2 w-2 rounded-full bg-success animate-pulse" />
                <span className="font-mono text-xs text-success">{LINK_MODE_LABEL[connection.mode]}</span>
                {connection.serialConnected && (
                  <span className="font-mono text-xs text-muted-foreground">{connection.serialPort}</span>
                )}
              </>
            ) : (
              <>
                <div className="h-2 w-2 rounded-full bg-warning" />
                <span className="font-mono text-xs text-warning">{LINK_MODE_LABEL.none}</span>
              </>
            )}
            <svg className="w-3 h-3 text-muted-foreground group-hover:text-foreground ml-1 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {/* Logging toggle */}
          <button
            onClick={toggleLogging}
            title={logging ? "Logging activo — click para parar" : "Click para iniciar logging"}
            className={`flex items-center gap-2 border rounded-lg px-3 py-1.5 transition-all font-mono text-xs ${
              logging
                ? "border-destructive/50 text-destructive hover:bg-destructive/10 animate-pulse"
                : "border-border/60 text-muted-foreground hover:bg-muted/40"
            }`}
          >
            <div className={`h-2 w-2 rounded-full ${logging ? "bg-destructive" : "bg-muted-foreground/40"}`} />
            {logging ? "REC" : "LOG"}
          </button>

          {/* Mission clock */}
          <button
            onClick={() => setClockOpen(true)}
            title={clockParts ? "Mission clock — click to adjust" : "Mission clock not started — click to set T-"}
            className="flex items-center gap-2 border-l border-border pl-4 hover:opacity-80 transition-opacity"
          >
            <span className="text-xs text-muted-foreground font-mono">
              {clockParts ? `T${clockParts.sign}` : "T"}
            </span>
            <span className={`font-mono text-lg font-semibold tracking-widest ${
              countingDown ? "text-warning" : "text-tertiary text-glow-tertiary"
            }`}>
              {clockParts?.text ?? "--:--:--"}
            </span>
          </button>
        </div>
      </nav>

      <MissionClockModal
        open={clockOpen}
        onClose={() => setClockOpen(false)}
        clock={missionClock}
        payloadUptime={payloadUptime}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
