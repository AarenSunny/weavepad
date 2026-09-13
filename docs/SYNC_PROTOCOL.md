# Synchronization protocol

WeavePad transports immutable CRDT operations over document-scoped WebSocket
rooms. The server is a durable relay, not an edit authority: replicas still
derive text independently from the operation set.

## Connection

Connect to `/documents/:documentId`. Document identifiers contain up to 128
letters, numbers, underscores, or hyphens. The server answers with:

```json
{
  "type":"ready",
  "documentId":"demo",
  "sessionId":"server-generated-id",
  "presence":{"type":"presence","documentId":"demo","revision":0,"participants":[]}
}
```

The ready payload carries the current ephemeral presence roster alongside the
durable synchronization channel. See [PRESENCE.md](PRESENCE.md) for its separate
lifecycle and cursor model.

The HTTP endpoint `GET /health` supports container and load-balancer health
checks.

## Catch-up

Each stored operation receives a monotonically increasing SQLite sequence. A
client remembers the greatest cursor it has fully processed and reconnects with:

```json
{"type":"sync","after":42}
```

The response contains every later operation for that document and the newest
cursor:

```json
{
  "type":"sync",
  "documentId":"demo",
  "cursor":45,
  "operations":[{"sequence":45,"operation":{"kind":"insert"}}]
}
```

Using a durable server cursor avoids a subtle version-vector hole: receiving an
actor's operation 12 does not prove that operation 11 was received. Sequence
queries make missed broadcasts recoverable even when client delivery is
interrupted or reordered.

## Publishing operations

Clients send up to 1,000 operations in a batch:

```json
{"type":"operations","operations":[...]}
```

The hub validates the entire batch against a copy of the current CRDT, writes new
operations in one SQLite transaction, and only then broadcasts an `operations`
message to every connected client. Identical replays are no-ops; an identifier
reused with another payload is rejected.

The WebSocket layer limits messages to 1 MiB. Malformed messages receive a
structured `error` response without terminating the room or affecting other
clients.

## Durability boundary

SQLite runs in write-ahead-log mode. The operation's server sequence is committed
before subscribers see it, so a cursor never acknowledges data that would vanish
on restart. A future PostgreSQL adapter can preserve the same append/load
interface for horizontally scaled deployments.
