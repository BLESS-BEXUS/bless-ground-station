/**
 * Optional: download the map tiles of an area into the local cache before going
 * offline. Without --yes it only prints how many tiles it would fetch.
 *
 *   npm run tiles:prefetch -- --radius-km 10 --min-zoom 8 --max-zoom 13
 *   npm run tiles:prefetch -- --radius-km 10 --min-zoom 8 --max-zoom 13 --yes
 *
 * The tile servers are a shared community resource (OpenStreetMap's usage policy
 * discourages bulk downloads), so keep the area small and run it once.
 */
import fs from "node:fs";
import path from "node:path";
import { rangeSize, tilesInArea, TileCache } from "./tiles";
import type { TileRange } from "./tiles";

function argValue(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value)) {
    console.error(`--${name} needs a number`);
    process.exit(1);
  }
  return value;
}

const lat = argValue("lat", 67.8856);
const lon = argValue("lon", 21.0786);
const radiusKm = argValue("radius-km", 10);
const minZoom = argValue("min-zoom", 8);
const maxZoom = argValue("max-zoom", 13);
const maxTiles = argValue("max-tiles", 1500);
const delayMs = argValue("delay-ms", 250);
const confirmed = process.argv.includes("--yes");

const ranges: TileRange[] = [];
for (let z = minZoom; z <= maxZoom; z++) ranges.push(tilesInArea(lat, lon, radiusKm, z));
const total = ranges.reduce((sum, r) => sum + rangeSize(r), 0);

console.log(`Area: ±${radiusKm} km around ${lat}, ${lon}, zoom ${minZoom}-${maxZoom}`);
for (const r of ranges) console.log(`  z${r.zoom}: ${rangeSize(r)} tiles`);
console.log(`Total: ${total} tiles (about ${(total * 0.02).toFixed(0)} MB)`);

if (total > maxTiles) {
  console.error(`More than --max-tiles (${maxTiles}). Reduce --radius-km or --max-zoom, or raise --max-tiles.`);
  process.exit(1);
}
if (!confirmed) {
  console.log("Dry run. Add --yes to download.");
  process.exit(0);
}

async function run(): Promise<void> {
  const cache = new TileCache(path.resolve(process.env.TILE_CACHE_DIR ?? "./tiles"), undefined, undefined, 1, 60_000);
  let done = 0;
  let fetched = 0;
  let failed = 0;
  for (const r of ranges) {
    for (let x = r.xMin; x <= r.xMax; x++) {
      for (let y = r.yMin; y <= r.yMax; y++) {
        const tile = { z: r.zoom, x, y };
        if (!fs.existsSync(cache.filePath(tile))) {
          const data = await cache.get(tile);
          if (data) fetched++; else failed++;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (failed > 0 && fetched === 0 && failed >= 3) {
            console.error("Upstream is not answering; stopping. Check the internet connection.");
            process.exit(1);
          }
        }
        done++;
        if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}  (downloaded ${fetched}, failed ${failed})`);
      }
    }
  }
  console.log(`Done. Downloaded ${fetched}, already cached ${total - fetched - failed}, failed ${failed}.`);
}

void run();
