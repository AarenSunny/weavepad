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

The HTTP endpoint `GET /health` reports process liveness. `GET /ready` verifies
that the required SQLite tables remain readable and is the traffic readiness
check.

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

Omitting `after` requests the document from cursor zero. If the field is
present, it must be a non-negative safe integer; explicit `null`, strings,
fractions, negative values, and unsafe integers receive a protocol error rather
than silently restarting a potentially large replay.

After server-side compaction, a client whose cursor predates the retained
checkpoint receives an additional checkpoint before the remaining operation
rows:

```json
{
  "type":"sync",
  "documentId":"demo",
  "cursor":120,
  "checkpoint":{"sequence":100,"operations":[...]},
  "operations":[...]
}
```

The client merges checkpoint operations idempotently into its existing local
replica, preserving offline work, then applies later rows and advances its
cursor. Pending identifiers found in either part are acknowledged. Clients at
or beyond checkpoint sequence receive only later rows.

## Publishing operations

Clients send up to 1,000 operations in a batch:

```json
{"type":"operations","operations":[...]}
```

The hub validates the entire batch against a copy of the current CRDT, writes new
operations in one SQLite transaction, and only then broadcasts an `operations`
message to every connected client. Identical replays are no-ops; an identifier
reused with another payload is rejected. If a submitted operation was already
durable, the server returns an `ack` containing that operation ID. This lets a
client clear replayed pending work even though a no-op does not create a second
broadcast or revision.

```json
{"type":"ack","documentId":"demo","cursor":45,"operationIds":["alice:12"]}
```

An acknowledgement confirms only that the IDs are durable on this server. It
does not prove that every connected replica has rendered them, and it is not a
flow-control signal. The browser also advances its durable reconnect cursor from
the acknowledgement after processing earlier WebSocket frames, so replay-only
batches do not leave it requesting an already confirmed history prefix.

The WebSocket layer limits messages to 1 MiB and enforces the documented
1,000-operation batch cap before opening a SQLite transaction. The browser
splits its pending queue at the same cap while preserving operation order, so a
long offline session does not create an immediately rejected reconnect message.
Malformed messages and operation batches over the batch cap receive a structured
`error` response without terminating the room. A frame over the 1 MiB transport
cap closes only the offending connection and increments the transport-error
metric; the process and other rooms remain available. Outbound sends also cap
each connection's queued bytes at 8 MiB by default. A message that would cross
the configured ceiling terminates only that slow connection and increments the
backpressure-disconnect metric; reconnect catch-up recovers from the durable
cursor. These bounds are not per-client rate limiting or admission control;
those remain deployment concerns for an internet-facing service.

## Durability boundary

SQLite runs in write-ahead-log mode. The operation's server sequence is committed
before subscribers see it, so a cursor never acknowledges data that would vanish
on restart. A future PostgreSQL adapter can preserve the same append/load
interface for horizontally scaled deployments.

Accepted operation batches also create transactional revision metadata. See
[VERSION_HISTORY.md](VERSION_HISTORY.md) for the replay-based preview API and
why historical reads never mutate live collaboration state. See
[COMPACTION.md](COMPACTION.md) for the checkpoint invariant and retention
boundary.
