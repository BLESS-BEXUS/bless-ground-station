export interface GroundStationLocation {
  lat: number;
  lng: number;
  alt: number;
  name: string;
}

// Ground station — campaign defaults, used only until the operator sets real coordinates
export const GROUND_STATION: GroundStationLocation = {
  lat: 67.8856,
  lng: 21.0786,
  alt: 310,
  name: "Esrange Space Center",
};

export const GROUND_STATION_STORAGE_KEY = "bless-ground-station";

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Parse a stored value field by field, so one bad field never discards the others. */
export function parseGroundStation(raw: string | null): GroundStationLocation {
  if (!raw) return GROUND_STATION;
  try {
    const parsed = JSON.parse(raw) as Partial<GroundStationLocation> | null;
    if (!parsed || typeof parsed !== "object") return GROUND_STATION;
    return {
      lat: finiteOr(parsed.lat, GROUND_STATION.lat),
      lng: finiteOr(parsed.lng, GROUND_STATION.lng),
      alt: finiteOr(parsed.alt, GROUND_STATION.alt),
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : GROUND_STATION.name,
    };
  } catch {
    return GROUND_STATION;
  }
}

export function loadGroundStation(): GroundStationLocation {
  try {
    return parseGroundStation(window.localStorage.getItem(GROUND_STATION_STORAGE_KEY));
  } catch {
    return GROUND_STATION;
  }
}

export function saveGroundStation(location: GroundStationLocation): void {
  try {
    window.localStorage.setItem(GROUND_STATION_STORAGE_KEY, JSON.stringify(location));
  } catch {
    // storage unavailable: the coordinates still apply for this page load
  }
}
