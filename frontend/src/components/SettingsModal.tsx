import { useState, useEffect } from "react";
import { useLiveData } from "@/hooks/useLiveData";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const { connection, changePort, listPorts } = useLiveData();
  const [ports, setPorts] = useState<{ path: string; manufacturer: string }[]>([]);
  const [selected, setSelected] = useState(connection.serialPort);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(connection.serialPort);
    setStatus(null);
    listPorts().then(setPorts);
  }, [open, connection.serialPort, listPorts]);

  async function apply() {
    setLoading(true);
    setStatus(null);
    const res = await changePort(selected);
    setStatus(res.ok ? { ok: true, msg: `Switching to ${selected}…` } : { ok: false, msg: res.error ?? "Error" });
    setLoading(false);
    if (res.ok) setTimeout(onClose, 1200);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-card border border-border rounded-xl w-full max-w-md p-6 space-y-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-sm font-bold text-primary uppercase tracking-widest">
            Serial Port Config
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground font-mono text-lg leading-none">
            ✕
          </button>
        </div>

        {/* Current status */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-background p-3">
          <div className={`h-2 w-2 rounded-full ${connection.serialConnected ? "bg-success animate-pulse" : "bg-destructive"}`} />
          <span className="font-mono text-xs text-muted-foreground">Current port:</span>
          <span className="font-mono text-sm font-semibold text-foreground">{connection.serialPort}</span>
          <span className={`ml-auto font-mono text-xs ${connection.serialConnected ? "text-success" : "text-destructive"}`}>
            {connection.serialConnected ? "CONNECTED" : "DISCONNECTED"}
          </span>
        </div>

        {/* Port selector */}
        <div className="space-y-2">
          <label className="font-mono text-xs text-muted-foreground uppercase tracking-wider">
            Select port
          </label>
          {ports.length > 0 ? (
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {ports.map((p) => (
                <button
                  key={p.path}
                  onClick={() => setSelected(p.path)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border font-mono text-sm transition-all ${
                    selected === p.path
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border bg-background text-foreground hover:border-border/60 hover:bg-muted/30"
                  }`}
                >
                  <span className="font-semibold">{p.path}</span>
                  {p.manufacturer && (
                    <span className="text-xs text-muted-foreground truncate ml-2">{p.manufacturer}</span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="font-mono text-xs text-muted-foreground italic">
              No ports detected — type manually below
            </p>
          )}

          {/* Manual input */}
          <input
            type="text"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            placeholder="COM3 / /dev/ttyUSB0"
            className="w-full bg-background border border-border rounded-lg px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary/60 mt-2"
          />
        </div>

        {/* Result */}
        {status && (
          <div className={`font-mono text-xs px-3 py-2 rounded-lg ${
            status.ok ? "bg-success/10 text-success border border-success/30" : "bg-destructive/10 text-destructive border border-destructive/30"
          }`}>
            {status.msg}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          <button
            onClick={() => listPorts().then(setPorts)}
            className="flex-1 px-4 py-2 rounded-lg border border-border font-mono text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-all"
          >
            ↻ Refresh
          </button>
          <button
            onClick={apply}
            disabled={loading || selected === connection.serialPort}
            className={`flex-1 px-4 py-2 rounded-lg font-mono text-xs font-semibold transition-all ${
              loading || selected === connection.serialPort
                ? "bg-primary/20 text-primary/40 cursor-not-allowed"
                : "bg-primary/20 text-primary border border-primary/40 hover:bg-primary/30"
            }`}
          >
            {loading ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
