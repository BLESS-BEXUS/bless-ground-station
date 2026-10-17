import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  DETAIL_MAX_NATIVE_ZOOM, MAP_BACKGROUND, MAP_MAX_ZOOM, OVERVIEW_MAX_NATIVE_ZOOM, TRANSPARENT_TILE, maxZoomForDistance,
} from "@/lib/mapTiles";

/** The RGBA pixel of a 1x1 PNG given as a data URI. */
function pixelOf(dataUri: string): { width: number; height: number; rgba: number[] } {
  const bytes = Buffer.from(dataUri.replace(/^data:image\/png;base64,/, ""), "base64");
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(bytes[24]).toBe(8);            // bit depth
  expect(bytes[25]).toBe(6);            // RGBA
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, rgba: [...raw.subarray(1, 5)] };       // skip the filter byte
}

describe("the placeholder for a tile that is not cached", () => {
  it("is a 1x1 PNG whose pixel is fully transparent: it never paints a coloured square", () => {
    const { width, height, rgba } = pixelOf(TRANSPARENT_TILE);
    expect([width, height]).toEqual([1, 1]);
    expect(rgba[3]).toBe(0);              // alpha 0
  });
});

describe("map zoom settings", () => {
  it("the overview is coarser than the detail, and the detail can be enlarged to the maximum zoom", () => {
    expect(OVERVIEW_MAX_NATIVE_ZOOM).toBeLessThan(DETAIL_MAX_NATIVE_ZOOM);
    expect(DETAIL_MAX_NATIVE_ZOOM).toBeLessThanOrEqual(MAP_MAX_ZOOM);
  });

  it("the background behind the tiles is a plain light colour", () => {
    expect(MAP_BACKGROUND).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("the zoom limit that follows the balloon", () => {
  it("allows full zoom near Esrange and when the position is unknown", () => {
    expect(maxZoomForDistance(0)).toBe(MAP_MAX_ZOOM);
    expect(maxZoomForDistance(30)).toBe(MAP_MAX_ZOOM);
    expect(maxZoomForDistance(null)).toBe(MAP_MAX_ZOOM);
    expect(maxZoomForDistance(Number.NaN)).toBe(MAP_MAX_ZOOM);
  });

  it("takes away the detail the cache does not hold as the balloon goes further out", () => {
    expect(maxZoomForDistance(31)).toBe(10);
    expect(maxZoomForDistance(120)).toBe(10);
    expect(maxZoomForDistance(121)).toBe(OVERVIEW_MAX_NATIVE_ZOOM);
    expect(maxZoomForDistance(500)).toBe(OVERVIEW_MAX_NATIVE_ZOOM);
    expect(maxZoomForDistance(601)).toBe(7);
  });

  it("never allows a zoom finer than the one before as the distance grows", () => {
    let previous = Infinity;
    for (let km = 0; km <= 900; km += 5) {
      const z = maxZoomForDistance(km);
      expect(z).toBeLessThanOrEqual(previous);
      previous = z;
    }
  });
});
