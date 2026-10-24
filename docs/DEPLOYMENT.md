# Deployment

The production server hosts the compiled React editor, WebSocket rooms, health
endpoint, and SQLite operation log in one process. Browser clients therefore use
the same origin for HTTP and WebSocket traffic with no CORS configuration.
Unknown extensionless application routes receive the React shell, while missing
paths under `/assets/` return `404` so a stale bundle request cannot be cached as
the application shell.

`GET /health` is the minimal process-liveness probe. `GET /ready` performs
lightweight reads against the three required SQLite tables and returns `503`
when durable collaboration state is unavailable; use it as the traffic
readiness gate. `GET /metrics` returns uncached, process-local JSON counters for
active and total WebSocket connections, received and rejected messages,
persisted operations, and uptime. The endpoint contains no document IDs, user
identities, or payloads. It is intentionally a single-process diagnostic rather
than durable telemetry; production deployments should restrict it at the
reverse proxy as appropriate and export centralized metrics, traces, and alerts
separately.

## Docker Compose

```bash
docker compose up --build
```

Open `http://localhost:3000/?document=demo`. The named `weavepad-data` volume
keeps `/data/weavepad.db` across container replacements.

The image uses a multi-stage build. Development packages and source UI files do
not enter the runtime layer, the process runs as the unprivileged `node` user,
and Docker checks process liveness at `GET /health` every ten seconds. An
orchestrator should separately route traffic only after `GET /ready` succeeds.

## Run without containers

```bash
npm ci
npm run build
HOST=0.0.0.0 PORT=3000 WEAVEPAD_DB=./weavepad.db npm start
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP/WebSocket bind address |
| `PORT` | `3000` | Service port |
| `WEAVEPAD_DB` | `weavepad.db` | SQLite database path |
| `WEAVEPAD_STATIC` | `dist` | Compiled editor directory |

## Reverse proxy

The proxy must pass WebSocket upgrades for `/documents/*` and should use a
request timeout longer than the expected editing session. Terminate TLS at the
proxy; the browser automatically selects `wss:` when the page uses HTTPS.

Only one WeavePad process should write a given SQLite database. Horizontal
scaling requires the planned PostgreSQL operation-store adapter plus shared
presence fan-out.

## Graceful shutdown and backups

`SIGTERM` and `SIGINT` stop accepting connections, close WebSockets, and close
SQLite before the process exits. For backups, stop the container or use SQLite's
online backup facilities; copying only the main database file while WAL writes
are active can produce an inconsistent backup.
