# WeavePad

WeavePad is a local-first collaborative editor built to demonstrate the hard
parts of real-time software: conflict-free text replication, offline editing,
reconnection, presence, and durable document history.

The first milestone implements the sequence CRDT at the center of the editor.
It accepts operations in any order, converges concurrent replicas without a
central lock, treats a user-perceived Unicode grapheme as one character, and
preserves deletes that arrive before their corresponding inserts.

## Current capabilities

- Local insert and delete operations over Unicode grapheme clusters
- Deterministic merge of concurrent insertions
- Tombstones for delete operations, including out-of-order delivery
- Idempotent operation replay and conflicting-operation detection
- Snapshots and per-replica version vectors
- WebSocket rooms with live operation broadcasts and reconnect catch-up
- Durable SQLite operation log with transactional, idempotent writes
- Revisioned collaborator presence with CRDT-anchored cursors and stale-session expiry
- Responsive React editor with offline queuing and shareable document URLs
- Single-service production image with health checks and persistent SQLite storage
- Three-replica offline-edit convergence tests
- Dependency-free TypeScript core with Node's built-in test runner

## Try the CRDT

Requires Node.js 24 or newer.

```bash
npm install
npm test
npm run check
```

Start the synchronization service (SQLite data is stored in `weavepad.db`):

```bash
npm start
```

In a second terminal, start the browser editor:

```bash
npm run dev
```

Open `http://127.0.0.1:5173/?document=demo` in two windows to see edits and
presence synchronize live. A production bundle is created with `npm run build`.
The [demo guide](docs/DEMO.md) provides a short portfolio walkthrough.

For a production-style single-service demo, run `docker compose up --build` and
open `http://localhost:3000/?document=demo`. See the
[deployment guide](docs/DEPLOYMENT.md) for configuration, persistence, reverse
proxy requirements, and backups.

Clients connect to `ws://127.0.0.1:3000/documents/<document-id>`. Send
`{"type":"sync","after":0}` to catch up, then publish locally generated CRDT
operations with `{"type":"operations","operations":[...]}`. Every accepted
batch is durably written before it is broadcast.

The connection's `ready` message includes a session identifier and the current
presence roster. See [docs/PRESENCE.md](docs/PRESENCE.md) for cursor updates,
heartbeats, expiry behavior, and the current trust boundary.

```ts
import { SequenceDocument } from "./src/crdt.ts";

const alice = new SequenceDocument("alice");
const initial = alice.localInsert(0, "Hello");

const bob = new SequenceDocument("bob");
bob.merge(initial);

const aliceEdit = alice.localInsert(5, "!");
const bobEdit = bob.localInsert(0, "Hi: ");

alice.merge(bobEdit);
bob.merge(aliceEdit);

console.log(alice.toString() === bob.toString()); // true
```

## Architecture

The CRDT uses immutable insert/delete operations and Lamport-style identifiers.
Every character references the character after which it was inserted. Concurrent
siblings are sorted deterministically, so all replicas derive the same text from
the same operation set. See [docs/CRDT.md](docs/CRDT.md) for the algorithm,
invariants, complexity, and tradeoffs.

Planned layers build around this core:

```text
React editor + offline queue + presence
          |
WebSocket synchronization service + cursor catch-up
          |
Sequence CRDT + version vectors
          |
SQLite operation log (PostgreSQL adapter planned)
```

## Roadmap

- [x] Convergent sequence CRDT
- [x] WebSocket synchronization and catch-up protocol
- [x] Durable SQLite operation log
- [ ] Snapshot compaction and PostgreSQL storage adapter
- [x] Multi-cursor presence and collaborator awareness
- [x] Responsive editor UI and document sharing links
- [ ] IndexedDB offline persistence and version history
- [x] Docker Compose demo and deployment guide
- [ ] Load and soak testing

This project is under active development. The checked items above are complete
and tested; unchecked items describe later milestones rather than current claims.

## License

MIT
