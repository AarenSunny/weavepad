# Checkpoint compaction

WeavePad can compact old SQLite operation rows into one retained CRDT
checkpoint while preserving reconnect correctness, offline edits, tombstones,
server restarts, and a bounded recent-history window.

## Safety invariant

For a checkpoint at durable sequence `S`:

1. the checkpoint contains every accepted CRDT operation through `S`;
2. the operation table contains only operations with sequences greater than
   `S`;
3. a client whose cursor is less than `S` receives and idempotently merges the
   checkpoint before post-checkpoint operations;
4. pending local operations are removed only when their identifiers occur in
   either the checkpoint or the post-checkpoint catch-up;
5. retained revision previews start at `S`, so no advertised revision depends
   on pruned operation rows.

The checkpoint contains operation identities and tombstones, not only visible
text. Replacing it with plain text would make delayed deletes and inserts
impossible to reconcile safely.

## Retention behavior

Compaction accepts a retained revision count from 1 through 100. The oldest
revision in that window becomes the new checkpoint. Older revision metadata and
operation rows through that sequence are deleted in the same SQLite
transaction. Re-running compaction without enough newer revisions is a no-op.

This deliberately changes version-history retention: previews older than the
checkpoint are no longer listed or addressable. It does not change the live
document, durable cursor monotonicity, or operation identifiers.

## Bounded experiment

```bash
npm run compaction-experiment
npm run compaction-experiment -- --batches 1000 --retain 50 --samples 25
```

The experiment creates an isolated temporary SQLite database, measures
cursor-zero materialization before and after compaction, validates exact text
and logical-operation counts, and removes the database on exit. Inputs are
capped at 2,000 batches, 100 retained revisions, and 100 timing samples.

### Verified development run — 2026-10-06

Node.js 24 on an Apple M4, local SQLite, 500 one-operation revisions, 25 retained
revisions, and 25 catch-up samples:

| Metric | Before | After |
|---|---:|---:|
| SQLite operation rows | 500 | 24 |
| Serialized CRDT payload | 65,659 bytes | 66,151 bytes |
| Logical CRDT operations | 500 | 500 |
| Median cursor-zero materialization | 1.649 ms | 1.353 ms |

The 95.2% row reduction and local timing are diagnostic evidence. Serialized
payload grew slightly because the checkpoint still retains all 500 operations
inside a JSON envelope. SQLite file pages are not reclaimed automatically, and
the result is not a multi-user throughput or production-capacity claim.

## Remaining production work

- automatic compaction scheduling and backpressure;
- multi-process or multi-node compaction leadership;
- backup-aware page reclamation and database maintenance;
- bounded/tiered checkpoint payloads for CRDTs that can safely garbage-collect
  tombstones using causal-stability knowledge;
- chunked checkpoint transport; the current checkpoint is one WebSocket
  message and is intentionally limited to the bounded experiment scope;
- PostgreSQL storage and distributed observability.
