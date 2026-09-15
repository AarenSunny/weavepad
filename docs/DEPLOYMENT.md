# Deployment

The production server hosts the compiled React editor, WebSocket rooms, health
endpoint, and SQLite operation log in one process. Browser clients therefore use
the same origin for HTTP and WebSocket traffic with no CORS configuration.

## Docker Compose

```bash
docker compose up --build
```

Open `http://localhost:3000/?document=demo`. The named `weavepad-data` volume
keeps `/data/weavepad.db` across container replacements.

The image uses a multi-stage build. Development packages and source UI files do
not enter the runtime layer, the process runs as the unprivileged `node` user,
and Docker checks `GET /health` every ten seconds.

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
