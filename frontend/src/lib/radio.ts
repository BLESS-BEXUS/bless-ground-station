/**
 * The payload no longer measures the radio link (it sends RSSI, SNR, noise floor
 * and frequency deviation as 0). The ground station measures them itself, on the
 * frames its own HaLow module receives, and the backend attaches them to every
 * packet as gsRssi, gsSnr, gsNoiseFloor and gsFreqDev.
 *
 * This decides which of the two to show: the payload's value when it is a real
 * reading, the ground station's otherwise, and nothing rather than a false 0.
 */

/** 0 dBm (the module's "nothing received") and anything below the noise are not readings. */
export function plausibleRssi(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value < 0 && value > -130;
}

export type RadioSource = "payload" | "ground";

export interface RadioInput {
  rssi?: number | null;
  snr?: number | null;
  noiseFloor?: number | null;
  freqDevHz?: number | null;
  gsRssi?: number | null;
  gsSnr?: number | null;
  gsNoiseFloor?: number | null;
  gsFreqDev?: number | null;
}

export interface RadioFigures {
  rssi: number | null;
  snr: number | null;
  noiseFloor: number | null;
  freqDevHz: number | null;
  /** Where RSSI / SNR / noise floor come from; null when there is no reading at all. */
  source: RadioSource | null;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

export function resolveRadio(input: RadioInput): RadioFigures {
  if (plausibleRssi(input.rssi)) {
    const snr = finite(input.snr) ? input.snr : null;
    const noiseFloor = finite(input.noiseFloor) && input.noiseFloor < 0
      ? input.noiseFloor
      : snr !== null ? input.rssi - snr : null;
    return {
      rssi: input.rssi,
      snr,
      noiseFloor,
      freqDevHz: finite(input.freqDevHz) ? input.freqDevHz : null,
      source: "payload",
    };
  }

  const freqDevHz = finite(input.gsFreqDev) ? input.gsFreqDev : null;
  if (plausibleRssi(input.gsRssi)) {
    const snr = finite(input.gsSnr) ? input.gsSnr : null;
    const noiseFloor = finite(input.gsNoiseFloor)
      ? input.gsNoiseFloor
      : snr !== null ? input.gsRssi - snr : null;
    return { rssi: input.gsRssi, snr, noiseFloor, freqDevHz, source: "ground" };
  }

  return { rssi: null, snr: null, noiseFloor: null, freqDevHz, source: null };
}
