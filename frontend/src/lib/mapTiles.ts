/**
 * How the map draws its background, so it is never a patch of colour or a blank hole.
 *
 * The backend serves the committed tile cache offline. Two layers are stacked:
 *   - an overview layer that only ever asks for zoom <= OVERVIEW_MAX_NATIVE_ZOOM and lets the
 *     browser enlarge those tiles, so anywhere the cache covers at least that, the map shows
 *     a coarse background at every zoom level (the balloon can be hundreds of km away);
 *   - a detail layer on top, with the real tiles up to DETAIL_MAX_NATIVE_ZOOM. A detail tile
 *     that is not cached is fully transparent, so the overview shows through instead.
 * Beyond DETAIL_MAX_NATIVE_ZOOM the last real tiles are enlarged rather than missing.
 */

/** The coarsest zoom the cache covers over the whole flight area (about 800 km around Esrange). */
export const OVERVIEW_MAX_NATIVE_ZOOM = 8;

/** The finest zoom the cache holds around the launch site. */
export const DETAIL_MAX_NATIVE_ZOOM = 16;

export const MAP_MAX_ZOOM = 19;

/** The colour of OpenStreetMap's own land, for the few places where no tile exists at all. */
export const MAP_BACKGROUND = "#f2efe9";

/**
 * A 1x1 PNG whose pixel is fully transparent (RGBA 0,0,0,0), shown for a tile that is not
 * cached. It must be transparent: anything else paints a visible square on the map.
 */
export const TRANSPARENT_TILE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";

/**
 * The finest zoom worth offering when the balloon is `distanceKm` from Esrange, the centre of the
 * stored tiles. Further out there is no detailed map to show, so zooming in would only enlarge a
 * blurry picture: the limit follows what the cache really holds (see backend/tiles/NOTICE.md).
 */
export function maxZoomForDistance(distanceKm: number | null): number {
  if (distanceKm === null || !Number.isFinite(distanceKm)) return MAP_MAX_ZOOM;
  if (distanceKm <= 30) return MAP_MAX_ZOOM;      // z11-16 stored: full zoom
  if (distanceKm <= 120) return 10;               // z9-10 stored
  if (distanceKm <= 600) return OVERVIEW_MAX_NATIVE_ZOOM;
  return 7;
}
