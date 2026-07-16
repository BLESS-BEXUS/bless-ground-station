# Requisitos e instalación — BLESS Ground Station

Este proyecto tiene tres partes independientes, cada una con sus propias dependencias.

## 1. Backend (Node.js / TypeScript)

```bash
cd backend
npm install
npm run dev
```

Variables de entorno relevantes (opcionales, valores por defecto entre paréntesis):

| Variable | Descripción |
|---|---|
| `HALOW_PORT` | Puerto serie del receptor T-HaLow (`COM3` en Windows; en macOS usar `/dev/tty.usbserial-XXXX`) |
| `ELINK_LOCAL_PORT` | Puerto UDP local donde el backend escucha telemetría del W5500 (`5000`) |
| `ELINK_REMOTE_IP` | IP del W5500 en el payload, para enviar comandos (`10.86.110.200`) |
| `ELINK_REMOTE_PORT` | Puerto UDP del W5500 para comandos (`5000`) |

## 2. Frontend (React / Vite)

```bash
cd frontend
npm install
npm run dev
```

Si `vite` no se reconoce como comando tras clonar el repo, es porque falta este `npm install` — `node_modules` no se versiona en git.

## 3. Extracción de datos de vuelo (Python)

Ver `requirements.txt` en esta carpeta. Uso recomendado con `uv` (evita tocar el entorno global):

```bash
uv run --with pyserial python capture_dump.py
uv run python bin_to_csv.py telemetry_dump.bin telemetry.csv
```

## Notas generales

- Trabajar siempre sobre la rama `develop` — `main` puede estar desactualizada respecto a los últimos fixes de protocolo/comandos.
- Antes de lanzar el backend, confirmar que ningún otro programa (PuTTY, Tera Term, monitor serie de CubeIDE) tiene el puerto COM del HaLow abierto.
