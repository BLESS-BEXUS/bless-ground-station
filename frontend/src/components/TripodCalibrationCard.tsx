import { useState } from "react";
import { calibrate, type TripodCalibration } from "@/lib/tripodCalibration";

interface Props {
  calibration: TripodCalibration | null;
  /** The true bearing / elevation computed right now, or null while the payload position is unknown. */
  computedAz: number | null;
  computedEl: number | null;
  onChange: (calibration: TripodCalibration | null) => void;
}

const signed = (value: number, decimals = 1) => `${value > 0 ? "+" : ""}${value.toFixed(decimals)}°`;

export default function TripodCalibrationCard({ calibration, computedAz, computedEl, onChange }: Props) {
  const [az, setAz] = useState(calibration ? String(calibration.tripodAz) : "");
  const [el, setEl] = useState(calibration ? String(calibration.tripodEl) : "");
  const [clockwise, setClockwise] = useState(calibration?.clockwise ?? false);

  const azNumber = Number(az);
  const elNumber = Number(el);
  const elevationGiven = el.trim() !== "";
  const inputsValid = az.trim() !== "" && Number.isFinite(azNumber) && (!elevationGiven || Number.isFinite(elNumber));
  const canCalibrate = inputsValid && computedAz !== null && computedEl !== null;

  function apply() {
    if (!canCalibrate || computedAz === null || computedEl === null) return;
    onChange(calibrate({
      computedAz,
      computedEl,
      tripodAz: azNumber,
      // no elevation typed: the tripod's elevation is already right, so no offset at all
      tripodEl: elevationGiven ? elNumber : computedEl,
      clockwise,
    }));
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <h3 className="font-mono text-xs text-muted-foreground uppercase tracking-widest">
        Tripod calibration — make the numbers match the tripod's scales
      </h3>
      <ol className="font-mono text-xs text-muted-foreground list-decimal pl-5 space-y-1">
        <li>Point the antenna exactly at the payload.</li>
        <li>Type what the tripod's azimuth scale reads right now (and the elevation only if it needs correcting).</li>
        <li>Press Calibrate. From then on the big numbers are the ones to dial on the tripod.</li>
      </ol>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex flex-col gap-1">
          <label className="font-mono text-xs text-muted-foreground" htmlFor="tripod-az">Tripod azimuth now (°)</label>
          <input
            id="tripod-az" type="number" step="0.1" value={az} placeholder="335"
            onChange={(e) => setAz(e.target.value)}
            className="bg-background border border-border rounded px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary/60"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-mono text-xs text-muted-foreground" htmlFor="tripod-el">Tripod elevation now (°) — optional</label>
          <input
            id="tripod-el" type="number" step="0.1" value={el} placeholder="empty = leave elevation as is"
            onChange={(e) => setEl(e.target.value)}
            className="bg-background border border-border rounded px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary/60"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="font-mono text-xs text-muted-foreground" htmlFor="tripod-dir">Azimuth numbers grow</label>
          <select
            id="tripod-dir" value={clockwise ? "cw" : "ccw"}
            onChange={(e) => setClockwise(e.target.value === "cw")}
            className="bg-background border border-border rounded px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:border-primary/60"
          >
            <option value="cw">turning right / clockwise (like a compass)</option>
            <option value="ccw">turning left / counter-clockwise (numbers drop turning right)</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={apply}
          disabled={!canCalibrate}
          className="px-4 py-2 rounded-lg bg-primary/20 text-primary border border-primary/40 font-mono text-xs font-semibold hover:bg-primary/30 transition-all disabled:opacity-40"
        >
          Calibrate to current pointing
        </button>
        <button
          onClick={() => onChange(null)}
          disabled={!calibration}
          className="px-4 py-2 rounded-lg border border-border font-mono text-xs text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-all disabled:opacity-40"
        >
          Reset calibration
        </button>
        {computedAz === null && (
          <span className="font-mono text-xs text-warning">Waiting for a payload position to calibrate against.</span>
        )}
      </div>

      {calibration ? (
        <p className="font-mono text-xs text-success">
          Calibrated{calibration.at ? ` at ${new Date(calibration.at).toLocaleTimeString()}` : ""}: tripod
          {" "}{calibration.tripodAz.toFixed(1)}° / {calibration.tripodEl.toFixed(1)}° was a true
          {" "}{calibration.computedAz.toFixed(1)}° / {calibration.computedEl.toFixed(1)}°.
          {" "}Azimuth scale: numbers {calibration.clockwise ? "grow turning right" : "drop turning right"}.
          {" "}Elevation: {Math.abs(calibration.elOffset) < 1e-9 ? "untouched" : `offset ${signed(calibration.elOffset)}`}.
        </p>
      ) : (
        <p className="font-mono text-xs text-muted-foreground">
          Not calibrated: the numbers shown are the true azimuth (from north) and elevation.
        </p>
      )}
      <p className="font-mono text-xs text-muted-foreground/70">
        Recalibrate if you move the tripod or change the ground-station coordinates. Saved in this browser
        for {window.location.origin}.
      </p>
    </div>
  );
}
