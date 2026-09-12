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

Clients connect to `ws://127.0.0.1:3000/documents/<document-id>`. Send
`{"type":"sync","after":0}` to catch up, then publish locally generated CRDT
operations with `{"type":"operations","operations":[...]}`. Every accepted
batch is durably written before it is broadcast.

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
React editor + presence
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
- [ ] Multi-cursor presence and collaborator awareness
- [ ] Offline browser persistence
- [ ] Editor UI, sharing flow, and version history
- [ ] Docker Compose demo, load tests, and deployment guide

This project is under active development. The checked items above are complete
and tested; unchecked items describe later milestones rather than current claims.

## License

MIT
