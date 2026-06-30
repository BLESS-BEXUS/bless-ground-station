# BLESS Mission Control Backend

Node.js + TypeScript backend that reads the T-HaLow USB serial port, parses the binary downlink protocol, and pushes live telemetry to the frontend via WebSocket.

## Quick start

```bash
npm install
# Run in dev mode (ts-node, no build needed)
HALOW_PORT=COM4 npm run dev
```

Replace `COM4` with your actual serial port (check Device Manager → Ports).

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
| GPS_FIX_SATS | 1 | bit7=fix, bits0-6=sats |
| RF_RSSI | 2 | dBm |
| RF_SNR | 1 | dBm |
| RF_FREQ_DEV | 2 | Hz |
| RF_SUCCESS_RATE | 1 | % PDR |
| RF_NOISE_FLOOR | 2 | dBm |
| RF_TX_MCS | 1 | MCS index |
| HALOW_VOLT | 2 | mV |
| HALOW_CURR | 2 | mA |
| TEMP_CHIP | 2 | centi-°C |
| MAIN_BUS_V | 2 | centi-V |
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

Available commands: `SYS_RESET`, `SYS_ON`, `SYS_OFF`, `SYS_START`, `SYS_STOP`, `PING`, `HEAT_MANUAL`, `HEAT_AUTO`, `HALOW_CONNECT`, `SET_TX_POWER`, `SET_MCS_MODE`, `RF_SILENCE`, `SAVE_DATA`, `SEND_HALOW`, `SEND_ELINK`

## WebSocket messages

The frontend connects to `ws://localhost:8765`.

**Server → client:**
```json
{ "type": "telemetry", "data": { ...BlessPacket } }
{ "type": "connection", "serial": true, "port": "COM4" }
```

## Logs

Each session creates `./logs/bless_YYYY-MM-DDTHH-MM-SS.csv` with all received packets.
