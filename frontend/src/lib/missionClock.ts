export const MISSION_CLOCK_STORAGE_KEY = "bless.missionClock.t0";

export interface MissionClockParts {
  sign: "-" | "+";
  text: string;
}

/**
 * Split a mission offset (ms relative to T=0) into sign and HH:MM:SS.
 * Before T=0 the seconds are rounded up, so the countdown reads T-00:00:01
 * and then flips to T+00:00:00 exactly at liftoff.
 */
export function missionClockParts(offsetMs: number): MissionClockParts {
  const negative = offsetMs < 0;
  const totalSeconds = negative ? Math.ceil(-offsetMs / 1000) : Math.floor(offsetMs / 1000);
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return { sign: negative ? "-" : "+", text: `${h}:${m}:${s}` };
}

export function formatMissionTime(offsetMs: number): string {
  const { sign, text } = missionClockParts(offsetMs);
  return `T${sign}${text}`;
}

/** Parse "HH:MM:SS" or "MM:SS" into seconds, or null if it is not a valid clock value. */
export function parseClockInput(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  const [h, m, s] = nums.length === 3 ? nums : [0, nums[0], nums[1]];
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

/** Epoch ms of T=0, or null when the clock has not been started. */
export function loadMissionT0(): number | null {
  try {
    const raw = localStorage.getItem(MISSION_CLOCK_STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveMissionT0(t0: number | null): void {
  try {
    if (t0 === null) localStorage.removeItem(MISSION_CLOCK_STORAGE_KEY);
    else localStorage.setItem(MISSION_CLOCK_STORAGE_KEY, String(t0));
  } catch {
    // storage unavailable: the clock still works for this page load
  }
}
