import { useCallback, useEffect, useState, type ReactNode } from "react";
import { HTTP_URL } from "@/lib/backendUrl";

/**
 * The ground station's antenna gain and polarization, LNA and cable loss: what the software
 * cannot read. It is saved by the backend and copied into the configuration file of every
 * mission (REC). The payload's equipment is in the SED and is not asked for here.
 */

type Polarization = "vertical" | "horizontal" | "rhcp" | "lhcp" | "slant45" | "unknown";

interface Equipment {
  groundAntenna: { gainDbi: number | null; polarization: Polarization };
  groundLna: { present: boolean | null; gainDb: number | null };
  groundCableLossDb: number | null;
  notes: string;
  updatedAt: string | null;
}

const POLARIZATIONS: { value: Polarization; label: string }[] = [
  { value: "unknown", label: "Unknown" },
  { value: "vertical", label: "Linear, vertical" },
  { value: "horizontal", label: "Linear, horizontal" },
  { value: "slant45", label: "Linear, 45°" },
  { value: "rhcp", label: "Circular, right-hand" },
  { value: "lhcp", label: "Circular, left-hand" },
];

interface Form {
  gain: string;
  polarization: Polarization;
  lna: "" | "yes" | "no";
  lnaGain: string;
  cable: string;
  notes: string;
}

const text = (n: number | null) => (n === null ? "" : String(n));

function toForm(e: Equipment): Form {
  return {
    gain: text(e.groundAntenna.gainDbi),
    polarization: e.groundAntenna.polarization,
    lna: e.groundLna.present === null ? "" : e.groundLna.present ? "yes" : "no",
    lnaGain: text(e.groundLna.gainDb),
    cable: text(e.groundCableLossDb),
    notes: e.notes,
  };
}

/** A blank field is "not known" (null); anything else must be a number. */
function numberOrNull(raw: string): number | null | "invalid" {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : "invalid";
}

function toEquipment(f: Form): Equipment | null {
  const gain = numberOrNull(f.gain);
  const lnaGain = numberOrNull(f.lnaGain);
  const cable = numberOrNull(f.cable);
  if (gain === "invalid" || lnaGain === "invalid" || cable === "invalid") return null;
  return {
    groundAntenna: { gainDbi: gain, polarization: f.polarization },
    groundLna: { present: f.lna === "" ? null : f.lna === "yes", gainDb: lnaGain },
    groundCableLossDb: cable,
    notes: f.notes,
    updatedAt: null,
  };
}

const inputClass =
  "bg-background border border-border rounded px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary/60 w-full";

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block font-mono text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export default function StationEquipmentCard() {
  const [form, setForm] = useState<Form | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${HTTP_URL}/gs/equipment`);
      const body = (await res.json()) as { equipment?: Equipment };
      if (res.ok && body.equipment) {
        setForm(toForm(body.equipment));
        setSavedAt(body.equipment.updatedAt);
      }
    } catch {
      // the card stays empty; the message below says so
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (form === null) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 font-mono text-xs text-muted-foreground">
        Station equipment — waiting for the backend.
      </div>
    );
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  const equipment = toEquipment(form);

  async function save() {
    if (!equipment) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${HTTP_URL}/gs/equipment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(equipment),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; equipment?: Equipment };
      if (res.ok && body.ok && body.equipment) {
        setForm(toForm(body.equipment));
        setSavedAt(body.equipment.updatedAt);
        setMessage({ ok: true, text: "Saved. Missions started from now on carry it." });
      } else {
        setMessage({ ok: false, text: body.error ?? "The backend refused it" });
      }
    } catch (e) {
      setMessage({ ok: false, text: `Backend not reachable (${String(e)})` });
    }
    setBusy(false);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="space-y-1">
        <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Ground station equipment</h3>
        <p className="font-mono text-xs text-muted-foreground">
          Antenna, LNA and cable loss, which the software cannot read. Each mission (REC) copies them into its
          mission_config file, so every run says what it was flown with.
        </p>
        <p className={`font-mono text-xs ${savedAt ? "text-success" : "text-warning"}`}>
          {savedAt
            ? `Confirmed ${new Date(savedAt).toLocaleString()}`
            : "Not entered yet: missions will say the ground equipment is unknown."}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Field label="Antenna gain (dBi)" htmlFor="eq-gain">
          <input id="eq-gain" type="number" step={0.1} className={inputClass} value={form.gain} onChange={(e) => set("gain", e.target.value)} />
        </Field>
        <Field label="Antenna polarization" htmlFor="eq-pol">
          <select id="eq-pol" className={inputClass} value={form.polarization} onChange={(e) => set("polarization", e.target.value as Polarization)}>
            {POLARIZATIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Cable and connector loss (dB)" htmlFor="eq-cable">
          <input id="eq-cable" type="number" step={0.1} min={0} className={inputClass} value={form.cable} onChange={(e) => set("cable", e.target.value)} />
        </Field>
        <Field label="LNA" htmlFor="eq-lna">
          <select id="eq-lna" className={inputClass} value={form.lna} onChange={(e) => set("lna", e.target.value as Form["lna"])}>
            <option value="">Unknown</option>
            <option value="yes">Fitted</option>
            <option value="no">None</option>
          </select>
        </Field>
        <Field label="LNA gain (dB)" htmlFor="eq-lna-gain">
          <input id="eq-lna-gain" type="number" step={0.1} className={inputClass} value={form.lnaGain} onChange={(e) => set("lnaGain", e.target.value)} />
        </Field>
      </div>

      <Field label="Notes" htmlFor="eq-notes">
        <textarea id="eq-notes" rows={2} className={inputClass} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={busy || equipment === null}
          className="px-4 py-2 rounded-lg bg-primary/20 text-primary border border-primary/40 font-mono text-xs font-semibold hover:bg-primary/30 transition-all disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save equipment"}
        </button>
        {equipment === null && (
          <span className="font-mono text-xs text-warning">A numeric field has something that is not a number.</span>
        )}
        {message && (
          <span className={`font-mono text-xs ${message.ok ? "text-success" : "text-destructive"}`}>{message.text}</span>
        )}
      </div>
    </div>
  );
}
