# Presence and cursor model

Presence answers a different question from the CRDT: who appears to be viewing
the document right now? It is deliberately ephemeral. User cursors should vanish
after a disconnect or timeout, while text operations must survive both.

## State

Each WebSocket connection receives a server-generated session identifier in its
`ready` message. A client announces itself with:

```json
{
  "type": "presence",
  "user": { "userId": "alice", "name": "Alice", "color": "#7C3AED" },
  "selection": { "anchor": "alice:14", "focus": "alice:18" }
}
```

Selections refer to immutable CRDT operation identifiers rather than numeric text
offsets. Numeric offsets become stale as remote text is inserted before them;
operation anchors remain meaningful across concurrent edits. `ROOT` represents
the beginning of a document, and a null selection means the editor is not
focused.

## Room snapshots

Every visible change broadcasts the complete room roster with a monotonically
increasing revision. Full snapshots keep clients simple and let them ignore any
older message that arrives late. Presence rooms are expected to be small; if a
deployment supports very large audiences this can evolve into revisioned deltas.

## Liveness

Clients send `{"type":"heartbeat"}` while connected. Heartbeats update liveness
without broadcasting a new roster, avoiding network noise. The default TTL is 30
seconds, checked every five seconds. Clean WebSocket disconnects remove a session
immediately; the TTL handles crashed processes and broken network paths.

Presence never enters SQLite or the CRDT operation log. After a server restart,
clients reconnect and announce themselves again.

## Trust boundary

The server validates names, colors, identifiers, and cursor anchors. Authentication
and signed document membership are later milestones, so the current `userId` is a
display identity rather than a verified account claim.
