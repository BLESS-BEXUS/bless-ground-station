import { useState } from "react";
import { useLiveData } from "@/hooks/useLiveData";

interface ParamDef {
  name: string;
  unit: string;
  min: number;
  max: number;
  default: number;
}

interface CommandDef {
  label: string;
  cmd: string;
  description: string;
  danger?: boolean;
  params?: ParamDef[];
}

const COMMANDS: CommandDef[] = [
  // System
  { label: "PING",       cmd: "PING",       description: "Comprueba el enlace E-Link y mide el tiempo de ida y vuelta" },
  { label: "SYS START",  cmd: "SYS_START",  description: "Inicia operaciones del experimento" },
  { label: "SYS STOP",   cmd: "SYS_STOP",   description: "Detiene el experimento (MCU en idle)", danger: true },
  { label: "SYS RESET",  cmd: "SYS_RESET",  description: "Reset del sistema", danger: true },
  // Heating
  {
    label: "HEAT MANUAL", cmd: "HEAT_MANUAL", description: "Control manual del calefactor",
    params: [{ name: "Duty Cycle", unit: "%", min: 0, max: 100, default: 0 }],
  },
  {
    label: "HEAT AUTO", cmd: "HEAT_AUTO", description: "Control automático (PID) del calefactor",
    params: [{ name: "Setpoint", unit: "°C", min: -40, max: 40, default: -10 }],
  },
  // RF / HaLow
  { label: "HaLow CONNECT", cmd: "HALOW_CONNECT", description: "Fuerza reconexión del módulo HaLow" },
  {
    label: "SET TX POWER", cmd: "SET_TX_POWER", description: "Configura la potencia de transmisión HaLow",
    params: [{ name: "TX Power", unit: "dBm", min: 0, max: 20, default: 10 }],
  },
  {
    label: "SET MCS MODE", cmd: "SET_MCS_MODE", description: "Configura el modo de modulación HaLow",
    params: [{ name: "MCS Index", unit: "", min: 0, max: 7, default: 0 }],
  },
  { label: "RF SILENCE",  cmd: "RF_SILENCE",  description: "Silencio de radio inmediato", danger: true },
  // Data
  { label: "SAVE DATA",   cmd: "SAVE_DATA",   description: "Fuerza volcado de logs a la Flash" },
  { label: "SEND HaLow",  cmd: "SEND_HALOW",  description: "Fuerza envío de datos por HaLow" },
  { label: "SEND E-Link", cmd: "SEND_ELINK",  description: "Fuerza envío de datos por E-Link" },
];

interface CommandModalProps {
  open: boolean;
  onClose: () => void;
}

export default function CommandModal({ open, onClose }: CommandModalProps) {
  const { sendCommand, connection } = useLiveData();
  const [selected, setSelected] = useState<CommandDef | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, number>>({});
  const [lastResult, setLastResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [sending, setSending] = useState(false);

  const disabled = !connection.wsConnected || !connection.elinkConnected;

  function openCmd(cmd: CommandDef) {
    setSelected(cmd);
    setLastResult(null);
    const defaults: Record<string, number> = {};
    cmd.params?.forEach((p) => { defaults[p.name] = p.default; });
    setParamValues(defaults);
  }

  async function send() {
    if (!selected) return;
    setSending(true);
    const params = selected.params?.map((p) => Math.round(paramValues[p.name] ?? p.default)) ?? [];
    const res = await sendCommand(selected.cmd, params);
    const pingDetails = selected.cmd === "PING" && res.ok
      ? `PONG · RTT ${res.rttMs} ms · token 0x${(res.token ?? 0).toString(16).padStart(4, "0")}`
      : null;
    setLastResult({
      ok: res.ok,
      msg: pingDetails ?? (res.ok ? `${selected.label} enviado` : (res.error ?? "Error")),
    });
    setSending(false);
    if (res.ok && selected.cmd !== "PING" && !selected.params?.length) setSelected(null);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="font-mono text-base font-bold text-primary">E-Link Commands</h2>
            <p className="font-mono text-xs text-muted-foreground mt-0.5">
              {disabled ? "Backend o socket E-Link UDP no disponible" : "Selecciona un comando para enviarlo al payload"}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors font-mono text-lg">✕</button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Command list */}
          <div className="w-56 border-r border-border overflow-y-auto p-3 space-y-1 shrink-0">
            {COMMANDS.map((cmd) => (
              <button
                key={cmd.cmd}
                onClick={() => openCmd(cmd)}
                disabled={disabled}
                className={`w-full text-left px-3 py-2 rounded font-mono text-xs transition-all ${
                  selected?.cmd === cmd.cmd
                    ? cmd.danger ? "bg-destructive/20 text-destructive border border-destructive/40"
                      : "bg-primary/15 text-primary border border-primary/30"
                    : disabled ? "text-muted-foreground/40 cursor-not-allowed"
                    : cmd.danger ? "text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {cmd.label}
              </button>
            ))}
          </div>

          {/* Detail panel */}
          <div className="flex-1 p-6 flex flex-col gap-4 overflow-y-auto">
            {selected ? (
              <>
                <div>
                  <h3 className={`font-mono text-base font-bold ${selected.danger ? "text-destructive" : "text-foreground"}`}>
                    {selected.label}
                  </h3>
                  <p className="font-mono text-xs text-muted-foreground mt-1">{selected.description}</p>
                  <p className="font-mono text-xs text-muted-foreground/60 mt-1">CMD ID: {selected.cmd}</p>
                </div>

                {selected.params && selected.params.length > 0 && (
                  <div className="space-y-4">
                    <p className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Parámetros</p>
                    {selected.params.map((p) => (
                      <div key={p.name} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="font-mono text-sm text-foreground">{p.name}</label>
                          <span className="font-mono text-sm font-bold text-primary">
                            {paramValues[p.name] ?? p.default}{p.unit}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={p.min}
                          max={p.max}
                          value={paramValues[p.name] ?? p.default}
                          onChange={(e) => setParamValues((prev) => ({ ...prev, [p.name]: Number(e.target.value) }))}
                          className="w-full accent-primary"
                          disabled={disabled}
                        />
                        <div className="flex justify-between font-mono text-xs text-muted-foreground/60">
                          <span>{p.min}{p.unit}</span>
                          <span>{p.max}{p.unit}</span>
                        </div>
                        <input
                          type="number"
                          min={p.min}
                          max={p.max}
                          value={paramValues[p.name] ?? p.default}
                          onChange={(e) => setParamValues((prev) => ({ ...prev, [p.name]: Number(e.target.value) }))}
                          className="w-full bg-background border border-border rounded px-3 py-1.5 font-mono text-sm text-foreground focus:outline-none focus:border-primary"
                          disabled={disabled}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {lastResult && (
                  <div className={`rounded px-3 py-2 font-mono text-xs ${lastResult.ok ? "bg-success/10 text-success border border-success/30" : "bg-destructive/10 text-destructive border border-destructive/30"}`}>
                    {lastResult.msg}
                  </div>
                )}

                <button
                  onClick={send}
                  disabled={disabled || sending}
                  className={`mt-auto px-4 py-2.5 rounded font-mono text-sm font-bold transition-all ${
                    disabled ? "bg-muted text-muted-foreground cursor-not-allowed opacity-40"
                    : selected.danger ? "bg-destructive/20 text-destructive border border-destructive/50 hover:bg-destructive/30"
                    : "bg-primary/20 text-primary border border-primary/40 hover:bg-primary/30"
                  }`}
                >
                  {sending ? "Enviando..." : `Enviar ${selected.label}`}
                </button>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground font-mono text-sm">
                Selecciona un comando
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
