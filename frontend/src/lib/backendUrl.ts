// The backend runs on the same machine/host that serves the UI.
export const BACKEND_HOST = window.location.hostname;
export const WS_URL = `ws://${BACKEND_HOST}:8765`;
export const HTTP_URL = `http://${BACKEND_HOST}:8765`;

/** Map tiles come from the backend's disk cache (downloaded once, then offline). */
export const TILE_URL = `${HTTP_URL}/tiles/{z}/{x}/{y}.png`;
