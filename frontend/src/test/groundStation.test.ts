import { beforeEach, describe, expect, it } from "vitest";
import {
  GROUND_STATION,
  GROUND_STATION_STORAGE_KEY,
  loadGroundStation,
  parseGroundStation,
  saveGroundStation,
} from "@/lib/groundStation";

describe("ground station storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("falls back to the campaign defaults when nothing is saved", () => {
    expect(loadGroundStation()).toEqual(GROUND_STATION);
  });

  it("round-trips saved coordinates", () => {
    const saved = { lat: 67.8890432, lng: 21.0836784, alt: 474, name: "Radar Hill" };
    saveGroundStation(saved);
    expect(loadGroundStation()).toEqual(saved);
  });

  it("keeps valid fields when another one is missing or corrupt", () => {
    const raw = JSON.stringify({ lat: 67.9, lng: 21.1, alt: null });
    expect(parseGroundStation(raw)).toEqual({ ...GROUND_STATION, lat: 67.9, lng: 21.1 });
  });

  it("ignores unparsable values", () => {
    window.localStorage.setItem(GROUND_STATION_STORAGE_KEY, "{not json");
    expect(loadGroundStation()).toEqual(GROUND_STATION);
    expect(parseGroundStation("null")).toEqual(GROUND_STATION);
  });
});
