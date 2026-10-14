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

The route is also appended to `logs/route.ndjson`, so it is restored when the
backend restarts. `GET /route` returns it and `POST /route/clear` empties it (the
map has a "Clear route" button). It is sent to new WebSocket clients as
`{ "type": "route", "points": [...] }`, followed by `{ "type": "route_point", "point": {...} }`
for each new fix.

## Offline map tiles

The map loads its tiles from the backend (`/tiles/{z}/{x}/{y}.png`). A tile is
downloaded from OpenStreetMap once, stored in `tiles/`, and served from disk from
then on, so anything you have viewed before opens instantly and works offline.
When there is no internet, uncached tiles fail immediately (blank) instead of
making the map wait.

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
cache on another ground-station computer, copy the `tiles/` folder.

## Logs

Logging starts automatically with the first packet received from either link (the
UI shows REC), and a manual stop is respected until you start it again. Each run creates two independent,
session-stamped files in `./logs`: `halow_live_<session>.csv` and
`elink_live_<session>.csv`. Confirmed mission-time synchronizations are written to
`mission_events_<session>.csv`, including the approximate UTC anchor for payload
`T+0`, the command-send UTC and the confirmation UTC. Rows are appended immediately so a process crash does
not lose an in-memory batch.

`GET /logs` lists the available CSV files and `GET /logs/<filename>` downloads a
specific file. `POST /logging/start` starts a new paired session and
`POST /logging/stop` pauses logging.
