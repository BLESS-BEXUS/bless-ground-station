import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPng, parseTileUrl, TileCache } from "./tiles";
import type { TileId } from "./tiles";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bless-tiles-"));
}

test("tile URLs are validated", () => {
  assert.deepEqual(parseTileUrl("/tiles/10/553/241.png"), { z: 10, x: 553, y: 241 });
  assert.deepEqual(parseTileUrl("/tiles/0/0/0.png?x=1"), { z: 0, x: 0, y: 0 });
  assert.equal(parseTileUrl("/tiles/2/4/0.png"), null);        // x out of range for z=2
  assert.equal(parseTileUrl("/tiles/20/0/0.png"), null);       // beyond max zoom
  assert.equal(parseTileUrl("/tiles/../../etc/passwd"), null);
  assert.equal(parseTileUrl("/tiles/1/1/1.jpg"), null);
  assert.equal(isPng(PNG), true);
  assert.equal(isPng(Buffer.from("<html>")), false);
});

test("a tile is downloaded once and then served from disk", async () => {
  const root = tempRoot();
  try {
    let downloads = 0;
    const cache = new TileCache(root, async () => { downloads++; return PNG; });
    const tile: TileId = { z: 12, x: 2210, y: 805 };

    assert.deepEqual(await cache.get(tile), PNG);
    assert.deepEqual(await cache.get(tile), PNG);
    assert.equal(downloads, 1);
    assert.equal(fs.existsSync(path.join(root, "12", "2210", "805.png")), true);

    // a new process (new cache object) still has it, with no upstream at all
    const offline = new TileCache(root, null);
    assert.deepEqual(await offline.get(tile), PNG);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("simultaneous requests for the same tile share one download", async () => {
  const root = tempRoot();
  try {
    let downloads = 0;
    const cache = new TileCache(root, async () => {
      downloads++;
      await new Promise((r) => setTimeout(r, 20));
      return PNG;
    });
    const tile: TileId = { z: 5, x: 17, y: 9 };
    const results = await Promise.all([cache.get(tile), cache.get(tile), cache.get(tile)]);
    assert.equal(downloads, 1);
    assert.equal(results.every((r) => r !== null), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("when the upstream is down, uncached tiles fail fast and are retried later", async () => {
  const root = tempRoot();
  try {
    let clock = 1_000;
    let attempts = 0;
    let online = false;
    const cache = new TileCache(
      root,
      async () => {
        attempts++;
        if (!online) throw new Error("getaddrinfo ENOTFOUND");
        return PNG;
      },
      () => clock,
      4,
      20_000,
    );

    assert.equal(await cache.get({ z: 3, x: 1, y: 1 }), null);
    assert.equal(attempts, 1);
    // within the back-off window: no new upstream attempts
    assert.equal(await cache.get({ z: 3, x: 2, y: 1 }), null);
    assert.equal(await cache.get({ z: 3, x: 3, y: 1 }), null);
    assert.equal(attempts, 1);

    online = true;
    clock += 21_000;
    assert.deepEqual(await cache.get({ z: 3, x: 2, y: 1 }), PNG);
    assert.equal(attempts, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an internet outage is reported once, not every back-off, and a recovery is reported too", async () => {
  const root = tempRoot();
  const warnings: string[] = [];
  const logs: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    let clock = 1_000;
    let online = false;
    const cache = new TileCache(root, async () => {
      if (!online) throw new Error("getaddrinfo ENOTFOUND tile.openstreetmap.org");
      return PNG;
    }, () => clock, 4, 20_000);

    // five back-off windows go by, with a request in each: one message in total
    for (let i = 0; i < 5; i++) {
      assert.equal(await cache.get({ z: 5, x: i, y: 1 }), null);
      clock += 21_000;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /No internet for new map tiles/);
    assert.match(warnings[0], /ENOTFOUND/);

    online = true;
    assert.deepEqual(await cache.get({ z: 5, x: 9, y: 1 }), PNG);
    assert.equal(logs.filter((l) => /reachable again/.test(l)).length, 1);

    // a new outage after the recovery is reported again
    online = false;
    clock += 21_000;
    assert.equal(await cache.get({ z: 5, x: 10, y: 1 }), null);
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = realWarn;
    console.log = realLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a non-PNG upstream answer is never cached", async () => {
  const root = tempRoot();
  try {
    const cache = new TileCache(root, async () => Buffer.from("<html>blocked</html>"));
    assert.equal(await cache.get({ z: 4, x: 8, y: 5 }), null);
    assert.equal(fs.existsSync(path.join(root, "4", "8", "5.png")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tile ranges around a point cover that point and grow with the radius", async () => {
  const { tilesInArea, rangeSize } = await import("./tiles");
  // Esrange (67.8856 N, 21.0786 E) falls in tile 10/571/245
  const small = tilesInArea(67.8856, 21.0786, 1, 10);
  assert.equal(small.xMin <= 571 && 571 <= small.xMax, true);
  assert.equal(small.yMin <= 245 && 245 <= small.yMax, true);
  const large = tilesInArea(67.8856, 21.0786, 30, 10);
  assert.equal(rangeSize(large) > rangeSize(small), true);
  // one zoom level deeper has ~4x as many tiles
  const deeper = tilesInArea(67.8856, 21.0786, 30, 11);
  assert.equal(rangeSize(deeper) >= 3 * rangeSize(large), true);
});
