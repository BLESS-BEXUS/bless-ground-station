/**
 * Two ends, two measurements. Each end of the HaLow link measures the frames it receives
 * from the other:
 *
 *   payload  RSSI / SNR / noise floor / frequency deviation  = the ground station's frames,
 *            received by the payload (the payload reports them in every packet, as 0 when
 *            it has no reading);
 *   ground   gsRssi / gsSnr / gsNoiseFloor / gsFreqDev       = the payload's frames, received
 *            by the ground station's own HaLow module (the backend attaches them to every
 *            packet from the module's status dump).
 *
 * They are different physical quantities, with different transmit powers, antennas and
 * receivers, so they are never merged into one figure and never used to fill each other's
 * gaps. A missing reading is null, not the other side's number and not a false 0.
 */

/** 0 dBm (the module's "nothing received") and anything below the noise are not readings. */
export function plausibleRssi(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value < 0 && value > -130;
}

export interface RadioFigures {
  rssi: number | null;
  snr: number | null;
  noiseFloor: number | null;
  freqDevHz: number | null;
}

const NONE: RadioFigures = { rssi: null, snr: null, noiseFloor: null, freqDevHz: null };

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export interface PayloadRadioInput {
  rssi?: number | null;
  snr?: number | null;
  noiseFloor?: number | null;
  freqDevHz?: number | null;
}

/**
 * What the payload measured. It sends all four figures as 0 when it has no reading, so
 * without a plausible RSSI none of them counts.
 */
export function payloadRadio(input: PayloadRadioInput): RadioFigures {
  if (!plausibleRssi(input.rssi)) return NONE;
  const snr = finite(input.snr) ? input.snr : null;
  const noiseFloor = finite(input.noiseFloor) && input.noiseFloor < 0
    ? input.noiseFloor
    : snr !== null ? input.rssi - snr : null;
  return { rssi: input.rssi, snr, noiseFloor, freqDevHz: finite(input.freqDevHz) ? input.freqDevHz : null };
}

export interface GroundRadioInput {
  gsRssi?: number | null;
  gsSnr?: number | null;
  gsNoiseFloor?: number | null;
  gsFreqDev?: number | null;
}

/** What the ground station's module measured on the payload's frames. */
export function groundRadio(input: GroundRadioInput): RadioFigures {
  const freqDevHz = finite(input.gsFreqDev) ? input.gsFreqDev : null;
  if (!plausibleRssi(input.gsRssi)) return { ...NONE, freqDevHz };
  const snr = finite(input.gsSnr) ? input.gsSnr : null;
  const noiseFloor = finite(input.gsNoiseFloor)
    ? input.gsNoiseFloor
    : snr !== null ? input.gsRssi - snr : null;
  return { rssi: input.gsRssi, snr, noiseFloor, freqDevHz };
}
