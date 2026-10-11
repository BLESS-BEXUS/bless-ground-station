import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export type TileFetcher = (tile: TileId) => Promise<Buffer>;

const USER_AGENT =
  "BLESS-GroundStation/1.0 (BEXUS 38 student experiment; +https://github.com/BLESS-BEXUS/bless-ground-station)";
const UPSTREAM_TEMPLATE = process.env.TILE_UPSTREAM ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAX_ZOOM = 19;
const MAX_TILE_BYTES = 1_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** `TILE_UPSTREAM=off` makes the server answer from the disk cache only. */
export function upstreamDisabled(template: string): boolean {
  return ["", "off", "none", "disabled"].includes(template.trim().toLowerCase());
}

export function parseTileUrl(url: string | undefined): TileId | null {
  const match = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png(?:\?.*)?$/.exec(url ?? "");
  if (!match) return null;
  const [z, x, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return null;
  return { z, x, y };
}

export interface TileRange {
  zoom: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** zoom);
}

/** Tiles covering a square of ±radiusKm around a point at one zoom level. */
export function tilesInArea(lat: number, lon: number, radiusKm: number, zoom: number): TileRange {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const last = 2 ** zoom - 1;
  const clamp = (v: number) => Math.min(last, Math.max(0, v));
  return {
    zoom,
    xMin: clamp(lonToTileX(lon - dLon, zoom)),
    xMax: clamp(lonToTileX(lon + dLon, zoom)),
    yMin: clamp(latToTileY(Math.min(85, lat + dLat), zoom)),
    yMax: clamp(latToTileY(Math.max(-85, lat - dLat), zoom)),
  };
}

export function rangeSize(r: TileRange): number {
  return (r.xMax - r.xMin + 1) * (r.yMax - r.yMin + 1);
}

export function isPng(data: Buffer): boolean {
  return data.length > PNG_SIGNATURE.length && data.subarray(0, 4).equals(PNG_SIGNATURE);
}

export function fetchUpstreamTile(tile: TileId, timeoutMs = 5000): Promise<Buffer> {
  const url = UPSTREAM_TEMPLATE
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": USER_AGENT }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`upstream answered HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_TILE_BYTES) { req.destroy(new Error("tile too large")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`upstream timeout after ${timeoutMs} ms`)));
    req.on("error", reject);
  });
}

/**
 * Read-through tile cache: a tile is downloaded once, stored on disk, and then
 * served from disk forever. When the upstream is unreachable it is not retried
 * for `backoffMs`, so uncached tiles fail fast instead of making the map hang.
 */
export class TileCache {
  private readonly inflight = new Map<string, Promise<Buffer | null>>();
  private downUntil = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    readonly root: string,
    private readonly fetchTile: TileFetcher | null = upstreamDisabled(UPSTREAM_TEMPLATE) ? null : fetchUpstreamTile,
    private readonly now: () => number = Date.now,
    private readonly maxConcurrent = 4,
    private readonly backoffMs = 20_000,
  ) {}

  filePath(tile: TileId): string {
    return path.join(this.root, String(tile.z), String(tile.x), `${tile.y}.png`);
  }

  async get(tile: TileId): Promise<Buffer | null> {
    const file = this.filePath(tile);
    try {
      return await fs.promises.readFile(file);
    } catch {
      // not cached yet
    }
    if (!this.fetchTile || this.now() < this.downUntil) return null;

    const key = `${tile.z}/${tile.x}/${tile.y}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.download(tile, file).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async download(tile: TileId, file: string): Promise<Buffer | null> {
    await this.acquire();
    try {
      if (this.now() < this.downUntil || !this.fetchTile) return null;
      const data = await this.fetchTile(tile);
      if (!isPng(data)) throw new Error("upstream did not return a PNG");
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, file);
      return data;
    } catch (err) {
      if (this.now() >= this.downUntil) {
        console.warn(
          `[tiles] Upstream unavailable (${err instanceof Error ? err.message : String(err)}); `
          + `serving only cached tiles for ${Math.round(this.backoffMs / 1000)} s`,
        );
      }
      this.downUntil = this.now() + this.backoffMs;
      return null;
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(() => { this.active++; resolve(); }));
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}

export async function handleTileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cache: TileCache,
): Promise<boolean> {
  if (req.method !== "GET" || !req.url?.startsWith("/tiles/")) return false;

  const tile = parseTileUrl(req.url);
  if (!tile) {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return true;
  }

  const data = await cache.get(tile);
  if (!data) {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "image/png",
    "Content-Length": data.length,
    "Cache-Control": "public, max-age=604800",
  });
  res.end(data);
  return true;
}
