# Sequence CRDT design

WeavePad's document is a replicated growable sequence inspired by RGA. Each
replica stores immutable operations and derives visible text from them. Peers do
not need to agree on delivery order; they only need to eventually receive the
same operations.

## Operation model

An insert contains a globally unique identifier, a replica name, a logical
counter, an anchor (`after`), and one Unicode grapheme. A delete contains its own
identifier and the identifier of the insert it removes.

Identifiers have the form `actor:counter`. A replica advances its logical clock
after every received operation before issuing another local operation. This gives
locally generated identifiers a stable causal ordering while the actor name
breaks ties between concurrent operations.

## Materializing text

The document builds an adjacency list from every insert's anchor. Inserts sharing
an anchor are concurrent siblings and are ordered by identifier. A depth-first
walk from the synthetic `ROOT` node yields the sequence. Deleted nodes remain in
the traversal as anchors but do not contribute text.

Sibling identifiers are visited in descending order. This makes a new insertion
at an existing cursor appear before the cursor's old successor while remaining
deterministic across replicas.

## Out-of-order delivery

Operations may arrive in any order:

- An insert whose anchor is not present stays in the operation graph and becomes
  reachable when its ancestor arrives.
- A delete whose target is not present is retained in `pendingDeletes`; the
  matching insert is immediately tombstoned when it arrives.
- Replaying an identical operation has no effect.
- Reusing an identifier with a different payload is rejected as corruption.

These rules make merge commutative and idempotent. Given the same valid operation
set, replicas produce the same sequence regardless of network delivery order.

## Unicode model

JavaScript string indices operate on UTF-16 code units, which can split emoji or
combining characters. WeavePad instead segments text with `Intl.Segmenter`, so a
grapheme such as `👩🏽‍💻` is inserted and deleted as one user-perceived character.

## State transfer

Snapshots currently contain the full immutable operation set. Version vectors
record the greatest counter observed from each actor and will drive incremental
catch-up: a peer can request only operations beyond its known counters.

## Complexity and tradeoffs

The first implementation favors auditability over optimization. Materializing
text rebuilds and sorts the adjacency graph, making reads approximately
`O(n log n)` in the number of inserts. Deletes remain as tombstones and snapshots
retain all operations.

Production milestones will add cached indexing, operation-log persistence, and
safe compaction after a server knows every active replica has observed a delete.
Compaction cannot discard anchors prematurely, because later operations may still
refer to them.
