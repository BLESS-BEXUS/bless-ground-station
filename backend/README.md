# BLESS Mission Control Backend

Node.js + TypeScript backend that reads the T-HaLow USB serial port, parses the binary downlink protocol, and pushes live telemetry to the frontend via WebSocket.

## Quick start

```bash
npm install
# Run in dev mode (ts-node, no build needed)
HALOW_PORT=COM4 npm run dev
```

Replace `COM4` with your actual serial port (check Device Manager → Ports).

The E-Link command channel uses UDP. Its defaults match the flight firmware:

```powershell
$env:ELINK_REMOTE_HOST = "10.86.110.200"
$env:ELINK_REMOTE_PORT = "5000"
$env:ELINK_LOCAL_PORT = "5000"
npm run dev
```

`ELINK_PING_TIMEOUT_MS` can be used to change the default 2000 ms timeout.

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

Available commands: `SYS_RESET`, `SYS_START`, `SYS_STOP`, `PING`, `SYNC_TIME`, `HEAT_MANUAL`, `HEAT_AUTO`, `HALOW_CONNECT`, `SET_TX_POWER`, `SET_MCS_MODE`, `RF_SILENCE`, `SAVE_DATA`, `SEND_HALOW`, `SEND_ELINK`

`SYNC_TIME` uses command ID `0x05` with an empty payload. The REST request only
returns success after the payload replies with `ACK: SYNC_TIME`.

## WebSocket messages

The frontend connects to `ws://localhost:8765`.

**Server → client:**
```json
{ "type": "telemetry", "data": { ...BlessPacket } }
{ "type": "elink_connection", "ready": true, "connected": true }
{ "type": "link_health", "elinkFresh": true, "halowFresh": false }
{ "type": "logging", "active": true }
```

## Logs

Logging starts automatically with the backend. Each run creates two independent,
session-stamped files in `./logs`: `halow_live_<session>.csv` and
`elink_live_<session>.csv`. Confirmed mission-time synchronizations are written to
`mission_events_<session>.csv`, including the approximate UTC anchor for payload
`T+0`, the command-send UTC and the confirmation UTC. Rows are appended immediately so a process crash does
not lose an in-memory batch.

`GET /logs` lists the available CSV files and `GET /logs/<filename>` downloads a
specific file. `POST /logging/start` starts a new paired session and
`POST /logging/stop` pauses logging.
