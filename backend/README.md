# BLESS Mission Control Backend

Node.js + TypeScript backend that reads the T-HaLow USB serial port, parses the binary downlink protocol, and pushes live telemetry to the frontend via WebSocket.

## Quick start

```bash
npm install
# Run in dev mode (ts-node, no build needed)
HALOW_PORT=COM4 npm run dev
```

Replace `COM4` with your actual serial port (check Device Manager → Ports).

A ground station that only receives E-Link (no T-HaLow attached) must not try to
open a serial port. Disable it with `HALOW_PORT=none` (`off` and `disabled` also work):

```powershell
$env:HALOW_PORT = "none"
npm run dev
```

The E-Link command channel uses UDP. Its defaults match the flight firmware:

```powershell
$env:ELINK_REMOTE_HOST = "10.86.110.200"
$env:ELINK_REMOTE_PORT = "5000"
$env:ELINK_LOCAL_PORT = "5000"
npm run dev
```

`ELINK_PING_TIMEOUT_MS` can be used to change the default 2000 ms timeout.

## Tests

```bash
npm test            # unit tests + end-to-end tests
npm run test:unit   # fast, no processes
npm run test:e2e    # starts the real backend against a fake T-HaLow and a fake payload
```

The end-to-end suite (`src/e2e.test.ts`) runs `src/index.ts` as a child process in a
temporary folder, with `test-support/fakeSerialport.js` standing in for the serial
module, and drives it through HTTP, WebSocket and UDP: telemetry, link switching,
AT commands, unplug/replug, corrupted streams, malformed requests and restarts.
`WS_PORT` and `ROUTE_HALOW_WINDOW_MS` exist for it; leave them unset in normal use.

## Architecture

```
LilyGO T-HaLow (USB) → SerialPort → Binary parser → WebSocket → React frontend
                                                    → CSV logger (./logs/)
                     REST API  ←─────────────────── Frontend (send commands)
```

## Serial protocol

Implements the BLESS downlink packet (Table 427, BX38_BLESS_SED_v2):

| Field | Bytes | Description |
|---|---|---|
| SYNC_MARKER | 2 | `0xB1E5` |
| TIMESTAMP | 4 | ms since boot |
| PACKET_COUNT | 4 | sequential counter |
| GPS_LAT | 4 | decimal degrees × 1e7 |
| GPS_LON | 4 | decimal degrees × 1e7 |
| GPS_ALT | 2 | meters ASL |
| GPS_FIX_SATS | 1 | bits7-6=fix quality, bits5-0=sats |
| RF_RSSI | 2 | dBm |
| RF_SNR | 1 | dBm |
| RF_FREQ_DEV | 2 | Hz |
| RF_SUCCESS_RATE | 1 | % PDR |
| RF_NOISE_FLOOR | 2 | dBm |
| RF_TX_MCS | 1 | MCS index |
| SYSTEM_STATE | 2 | `0=INIT`, `1=IDLE`, `2=FLIGHT` |
| HALOW_CURR | 2 | mA |
| TEMP_CHIP | 2 | whole °C |
| HEATER_POWER | 2 | centi-% |
| ENV_PRESS | 4 | Pa |
| EXT_TEMP | 2 | centi-°C |
| INT_TEMP | 2 | centi-°C |
| EXT_HUM | 2 | centi-RH% |
| RAD_CPS | 2 | counts/s |
| ERROR_FLAGS | 1 | bitmask |
| CHECKSUM | 2 | CRC-16 |

**Total: 53 bytes**

## REST API — Send commands (Table 428)

```bash
# CMD_PING
curl -X POST http://localhost:8765/cmd/PING

# CMD_SYS_STOP
curl -X POST http://localhost:8765/cmd/SYS_STOP

# CMD_HEAT_MANUAL heater_id=1, pwm=128
curl -X POST http://localhost:8765/cmd/HEAT_MANUAL \
     -H "Content-Type: application/json" \
     -d '{"params":[1,128]}'

# CMD_SET_TX_POWER power=14
curl -X POST http://localhost:8765/cmd/SET_TX_POWER \
     -H "Content-Type: application/json" \
     -d '{"params":[14]}'
```

A successful ping waits for the matching binary PONG and returns its token and
round-trip time:

```json
{ "ok": true, "cmd": "PING", "token": 4660, "rttMs": 12, "from": "10.86.110.200:5000" }
```

Available commands: `SYS_RESET`, `SYS_START`, `SYS_STOP`, `PING`, `SYNC_TIME`, `HEAT_MANUAL`, `HEAT_AUTO`, `HALOW_CONNECT`, `SET_TX_POWER`, `SET_MCS_MODE`, `RF_SILENCE`, `SET_HALOW_MODE` (param 0 = AP, 1 = GROUP), `SAVE_DATA`, `SEND_HALOW`, `SEND_ELINK`

`SYNC_TIME` uses command ID `0x05` with an empty payload. The REST request only
returns success after the payload replies with `ACK: SYNC_TIME`.

## WebSocket messages

The frontend connects to `ws://localhost:8765`.

**Server → client:**
```json
{ "type": "telemetry", "data": { ...BlessPacket } }
{ "type": "elink_connection", "ready": true, "connected": true }
{ "type": "link_health", "elinkFresh": true, "halowFresh": false }
{ "type": "route", "points": [ { "lat": 67.9, "lng": 21.1, "alt": 1200, "t": 1791710696733, "link": "halow", "pkt": 42, "rssi": -71 } ] }
{ "type": "route_point", "point": { "lat": 67.9, "lng": 21.1, "alt": 1200, "t": 1791710696733, "link": "elink", "pkt": 43, "rssi": -73 } }
{ "type": "logging", "active": true }
```

## Ground-station HaLow configuration

The "GS Config" tab sends AT commands to the T-HaLow module plugged into the ground
station, using the same interface the payload firmware uses on its own module
(`AT+<NAME>=<value>

`, answered by a line with `OK` or `ERROR`). It is the ground
module that changes, never the payload: use the E-Link commands for the payload.

| Command | Meaning | Accepted values |
|---|---|---|
| `TXPOWER` | TX power in dBm | 6-20 (payload limits) |
| `TX_MCS` | Transmit MCS | 0-7 |
| `BSS_BW` | Channel width in MHz | 1, 2, 4, 8 |
| `FREQ_RANGE` | Band in 100 kHz units, e.g. `8660,8670` | 7500-9300 |
| `ACKTMO` | ACK timeout, 10 x (link km - 1) | 0-65535 |
| `MODE`, `SSID`, `PSK` | Network identity (AP / STA) | see the tab |

A command is retried up to 3 times (1 s each) if the module stays silent, like the
payload does; an `ERROR` answer is reported without retrying. `BSS_BW`, `FREQ_RANGE`
and the network settings break the link unless the payload uses the same values, so
the tab asks for confirmation first. The PSK is never shown or logged.

```bash
# Same thing from the command line
curl -X POST http://localhost:8765/halow/config      -H "Content-Type: application/json"      -d '{"name":"TXPOWER","value":"12"}'
curl http://localhost:8765/halow/config      # applied values and command history
```

Each command (applied or failed) is written to `mission_events_<session>.csv` as
`GROUND_HALOW_CONFIG` with the setting in the `source` column, so RSSI and PDR can be
compared against the radio settings that were active.

## Payload route

Every packet with a valid GNSS fix (from HaLow or E-Link) adds a point to the
route, recorded by the backend so every open page shows the same route and it
survives page reloads. Each point carries the link state when it was recorded:

- `halow` (blue): HaLow GNSS has been received in the last 30 s (E-Link may be
  arriving too).
- `elink` (yellow): HaLow GNSS is gone and only E-Link keeps arriving.

Each point also stores the packet's `rssi` (dBm), which the RSSI heat map uses. A
reading of 0 dBm (an occasional payload glitch) or anything outside -130..0 dBm is
stored as `null` and drawn as a grey dot.

The map starts empty every time the backend starts: the live route is journaled in
`logs/route.ndjson` while the backend runs, and that journal is emptied at startup.
Nothing is lost: each mission keeps its own route in its folder (see Logs). `GET /route`
returns the live route and `POST /route/clear` empties it (the map has a "Clear route"
button). It is sent to new WebSocket clients as
`{ "type": "route", "points": [...] }`, followed by `{ "type": "route_point", "point": {...} }`
for each new fix.

## Offline map tiles

The map loads its tiles from the backend (`/tiles/{z}/{x}/{y}.png`). A tile is
downloaded from OpenStreetMap once, stored in `tiles/`, and served from disk from
then on, so anything you have viewed before opens instantly and works offline.
When there is no internet, uncached tiles fail immediately (blank) instead of
making the map wait.

**The tiles are in the repository.** `backend/tiles/` (about 2300 tiles, 24 MB) is committed, so
after a plain `git clone` or `git pull` the map works offline with no extra step. Coverage, all
centred on Esrange:

| Zoom | Radius | What it is for |
|---|---|---|
| 0-7 | 800 km | the whole flight area: the balloon can be 500 km away or more |
| 8 | 600 km | the coarse background that is enlarged at any higher zoom |
| 9-10 | 120 km | the surroundings of the launch site |
| 11-12 | 30 km | the campaign area |
| 13-16 | 10 and 3 km | Radar Hill, the MPF and the Dome, street level |

The map stacks two layers (`frontend/src/lib/mapTiles.ts`): an overview that only uses zoom 8 or
lower and is enlarged, and the real tiles on top. Where a detailed tile is not stored, the overview
shows through, blurry but with the coast, lakes and roads, instead of a hole. A tile that is missing
is transparent (never a coloured square). The zoom is also capped by how far the balloon is from
Esrange, so it never offers detail the folder does not hold: full zoom up to 30 km, zoom 10 up to
120 km, zoom 8 up to 600 km, zoom 7 beyond (zooming out is always free). Map data © OpenStreetMap contributors (ODbL, see
`tiles/NOTICE.md`). Tiles you view that are not stored are still downloaded when there is internet
and added to the folder; commit them if they should reach the others. The backend says once, not
every few seconds, when it has no internet; `TILE_UPSTREAM=off` stops it trying.

| Variable | Default | Meaning |
|---|---|---|
| `TILE_CACHE_DIR` | `./tiles` | Where tiles are stored |
| `TILE_UPSTREAM` | OSM standard tiles | Tile URL template, or `off` to serve only what is cached |

To fill the cache for an area before going offline (a dry run prints the tile
count first; add `--yes` to download):

```bash
npm run tiles:prefetch -- --radius-km 10 --min-zoom 8 --max-zoom 13
npm run tiles:prefetch -- --radius-km 3 --min-zoom 14 --max-zoom 16 --yes
```

OpenStreetMap's tile servers are a shared community resource and their usage
policy discourages bulk downloads: keep the area small and run it once. To reuse a
cache on a computer that does not use the repository, copy the `tiles/` folder.

## Logs

Logging starts automatically with the first packet received from either link (the
UI shows REC), and a manual stop is respected until you start it again. Every REC
creates one folder, `./logs/mission_<session>/`, and everything the run produces goes in it:

```
logs/mission_2026-10-15T08-47-58-929Z/
  halow_live_<session>.csv        one row per HaLow packet
  elink_live_<session>.csv        one row per E-Link packet
  gs_rf_live_<session>.csv        the ground module's radio dumps
  mission_events_<session>.csv    time syncs, ground-radio changes, payload commands, GS position
  route_<session>.ndjson          the mission's route, one point per line, appended live
  route_<session>.geojson         the same route for QGIS (rewritten while recording)
  mission_config_<session>.json   how the run was set up (see below)
```

Confirmed mission-time synchronizations are written to `mission_events_<session>.csv`,
including the approximate UTC anchor for payload `T+0`, the command-send UTC and the
confirmation UTC. Commands sent to the payload (`SET_TX_POWER`, `SET_MCS_MODE`, ...)
are written as `PAYLOAD_COMMAND` rows with their parameters. Rows are appended
immediately so a process crash does not lose an in-memory batch.

Nothing is queued while no mission is recording: an AT command sent to the ground
module before the first packet, or between two missions, is not written as an event.
It is not lost either: the next mission's `mission_config` lists every setting applied
so far (`appliedFromSoftware`) with the time it was applied. A finished mission's
folder is never written to again.

`GET /logs` lists the files of every mission (`mission_<session>/<file>`), and
`GET /logs/mission_<session>/<file>` downloads one (CSV, or the JSON configuration).
`POST /logging/start` starts a new mission and `POST /logging/stop` closes it (the
configuration gets its end time). `GET /mission` returns the folder and configuration
of the current or last mission.

Each mission has its own route. `route_<session>.ndjson` gets one JSON point per line
(`lat`, `lng`, `alt`, `t`, `link`, `pkt`, `rssi`, the same format as the live map's
journal) the moment the point is recorded, so a crash loses nothing, and it only holds
that mission's points. `route_<session>.geojson` is the same route as a FeatureCollection
for QGIS: `route` lines (blue = HaLow GNSS, yellow = E-Link only), one `rssi-leg` line per
segment colored by signal strength, and one Point per recorded packet. It is rewritten every
30 s while recording (`ROUTE_SAVE_INTERVAL_MS`) and at REC stop or shutdown. The live map's
own journal (`logs/route.ndjson`) stays at the top of `./logs`; it only feeds the map while the
backend runs, it is emptied at every startup, and it is not tied to a mission.

### Mission configuration (`mission_config_<session>.json`)

Written when the mission starts and rewritten whenever something in it changes:

| Section | What it says |
|---|---|
| `mission` | session, folder, start and end time, files, row counts |
| `groundStation.position` | where the GS was (coordinates entered on the Antenna tab) and when it was reported; `positionChanges` lists the changes during the run |
| `groundStation.radio` | the ground module's port, every AT setting applied from the software (`appliedFromSoftware`), the TX power (`txPower`: applied value, or "not set this run" with the mission default), and what the module reported about itself |
| `groundStation.equipment` | antenna gain and polarization, LNA, cable loss, as the operator entered them on the GS Config tab (`confirmedByOperator` is false until they save it) |
| `payload` | the TX power set by the last `SET_TX_POWER` sent from the software (null if none) and every command sent, flagged when it was sent before the mission began |

The equipment is kept in `station_equipment.json` next to the backend (override with
`STATION_EQUIPMENT_FILE`), so it survives restarts; `GET/POST /gs/equipment` read and
save it. Only the ground side is kept: the payload's own equipment and configuration are
in the SED, and the software never assumes them.

### Ground-station position and distance to the payload

The ground station's coordinates are entered on the Antenna tab and kept by the page,
which reports them to the backend when it connects and whenever they change
(`POST /gs/position` with `{ "lat", "lng", "alt", "name", "source" }`; `GET /gs/position`
returns the current one). With that the backend:

- writes a `GROUND_STATION_POSITION` row to `mission_events_<session>.csv`, as the
  first event of every session and again each time the position changes. The `status`
  column is `OPERATOR` (coordinates the operator entered) or `DEFAULT` (the campaign
  default the page falls back to), and `source` holds `lat=..;lng=..;alt=..;name=..`.
- adds `gsDistHorizontalM` and `gsDistSlantM` (metres, ground distance and straight
  line from the ground station to the payload, computed as on the Map tab) to every
  row of `halow_live_<session>.csv` and `elink_live_<session>.csv`. They are empty
  while the position is `DEFAULT` and for packets without a GNSS fix. The same two
  figures travel with the telemetry the pages receive.
