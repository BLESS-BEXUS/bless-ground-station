import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RoutePoint } from "./track";
import { routeToGeoJson, rssiColorHex, writeMissionRoute } from "./missionRoute";

const point = (i: number, over: Partial<RoutePoint> = {}): RoutePoint => ({
  lat: 67.89 + i * 0.001, lng: 21.08 + i * 0.001, alt: 340 + i, t: 1_000 * i, link: "halow", pkt: i, rssi: -60 - i, ...over,
});

test("the route has one colored line per link stretch, one line per leg, and every point", () => {
  const points = [point(0), point(1), point(2, { link: "elink", rssi: null }), point(3, { link: "elink", rssi: null })];
  const geo = routeToGeoJson(points, { session: "s1", reason: "rec-stop" }, new Date("2026-10-15T10:00:00Z"));

  const features = geo.features as { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown[] } }[];
  const routes = features.filter((f) => f.properties.kind === "route");
  assert.equal(routes.length, 2, "a HaLow stretch and an E-Link-only stretch");
  assert.deepEqual(routes.map((f) => f.properties.stroke), ["#1E88FF", "#FFC400"]);
  assert.equal(routes[1].geometry.coordinates.length, 3, "a stretch starts at the last point of the previous one");

  const legs = features.filter((f) => f.properties.kind === "rssi-leg");
  assert.equal(legs.length, 3);
  assert.equal(legs[2].properties.rssi, null, "no reading, no color scale");
  assert.equal(legs[2].properties.stroke, "#9AA5B1");

  const pts = features.filter((f) => f.geometry.type === "Point");
  assert.deepEqual(pts.map((f) => f.properties.kind), ["start", "point", "point", "end"]);
  assert.deepEqual((pts[0].geometry.coordinates as number[]), [21.08, 67.89, 340], "GeoJSON order is lng, lat, alt");

  assert.deepEqual(geo.bless, {
    session: "s1", reason: "rec-stop", points: 4,
    startedAt: "1970-01-01T00:00:00.000Z", endedAt: "1970-01-01T00:00:03.000Z", writtenAt: "2026-10-15T10:00:00.000Z",
  });
});

test("the signal colors match the live map's scale", () => {
  assert.equal(rssiColorHex(null), "#9AA5B1");
  assert.equal(rssiColorHex(-107), "#8e0f1b");
  assert.equal(rssiColorHex(-30), "#1b7f3b");
  assert.equal(rssiColorHex(-200), "#8e0f1b", "below the scale clamps to the worst color");
});

test("the route is written into the mission folder and replaced, never duplicated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bless-route-"));
  try {
    assert.equal(writeMissionRoute(dir, [], { session: "abc", reason: "recording" }), null, "nothing to save");
    assert.deepEqual(fs.readdirSync(dir), []);

    assert.equal(writeMissionRoute(dir, [point(0), point(1)], { session: "abc", reason: "recording" }), "route_abc.geojson");
    assert.equal(writeMissionRoute(dir, [point(0), point(1), point(2)], { session: "abc", reason: "rec-stop" }), "route_abc.geojson");
    assert.deepEqual(fs.readdirSync(dir), ["route_abc.geojson"], "one file, no temporary leftovers");

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "route_abc.geojson"), "utf-8"));
    assert.equal(saved.bless.points, 3);
    assert.equal(saved.bless.reason, "rec-stop");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
