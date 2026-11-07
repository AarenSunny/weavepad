import assert from "node:assert/strict";
import { test } from "node:test";
import { SequenceDocument, type Operation } from "../src/crdt.ts";

test("local edits preserve grapheme boundaries", () => {
  const document = new SequenceDocument("alice");
  document.localInsert(0, "Hi 👩🏽‍💻!");
  assert.equal(document.toString(), "Hi 👩🏽‍💻!");
  assert.equal(document.length, 5);
  document.localDelete(3, 1);
  assert.equal(document.toString(), "Hi !");
});

test("concurrent insertions converge regardless of delivery order", () => {
  const alice = new SequenceDocument("alice");
  const base = alice.localInsert(0, "AB");
  const bob = new SequenceDocument("bob");
  bob.merge(base);

  const fromAlice = alice.localInsert(1, "X");
  const fromBob = bob.localInsert(1, "Y");
  alice.merge(fromBob);
  bob.merge(fromAlice);

  assert.equal(alice.toString(), bob.toString());
  assert.equal(alice.toString().length, 4);
  assert.ok(alice.toString().startsWith("A"));
  assert.ok(alice.toString().endsWith("B"));
});

test("deletes arriving before their insert become tombstones", () => {
  const source = new SequenceDocument("source");
  const [insert] = source.localInsert(0, "Z");
  const [remove] = source.localDelete(0);
  const receiver = new SequenceDocument("receiver");

  receiver.apply(remove);
  receiver.apply(insert);
  assert.equal(receiver.toString(), "");
  assert.deepEqual(receiver.versionVector(), { source: 2 });
});

test("duplicate delivery is idempotent and conflicting IDs are rejected", () => {
  const source = new SequenceDocument("source");
  const [operation] = source.localInsert(0, "A");
  const receiver = new SequenceDocument("receiver");
  assert.equal(receiver.apply(operation), true);
  assert.equal(receiver.apply({
    value: operation.value,
    after: operation.after,
    counter: operation.counter,
    actor: operation.actor,
    id: operation.id,
    kind: operation.kind,
  }), false);
  assert.equal(receiver.toString(), "A");
  assert.throws(() => receiver.apply({ ...operation, value: "B" }), /conflicting operation/);

  const [deletion] = source.localDelete(0);
  assert.equal(receiver.apply(deletion), true);
  assert.equal(receiver.apply({
    target: deletion.target,
    counter: deletion.counter,
    actor: deletion.actor,
    id: deletion.id,
    kind: deletion.kind,
  }), false);
  assert.equal(receiver.toString(), "");
});

test("cyclic insert anchors are rejected without mutating the replica", () => {
  const document = new SequenceDocument("alice");
  assert.throws(() => document.apply({
    kind: "insert", id: "alice:99", actor: "alice", counter: 99,
    after: "alice:99", value: "X",
  }), /anchors must not form a cycle/);
  const [local] = document.localInsert(0, "A");
  assert.equal(local.id, "alice:1");
  assert.equal(document.toString(), "A");

  assert.throws(() => SequenceDocument.fromSnapshot("reader", { operations: [
    { kind: "insert", id: "one:1", actor: "one", counter: 1, after: "two:1", value: "1" },
    { kind: "insert", id: "two:1", actor: "two", counter: 1, after: "one:1", value: "2" },
  ] }), /anchors must not form a cycle/);
});

test("anchors and delete targets resolve only to insert operations", () => {
  const known = new SequenceDocument("known");
  known.apply({
    kind: "delete", id: "remove:1", actor: "remove", counter: 1, target: "missing:1",
  });
  const knownSnapshot = known.snapshot();
  assert.throws(() => known.apply({
    kind: "insert", id: "writer:1", actor: "writer", counter: 1,
    after: "remove:1", value: "X",
  }), /must reference insert operations/);
  assert.throws(() => known.apply({
    kind: "delete", id: "writer:1", actor: "writer", counter: 1, target: "remove:1",
  }), /must reference insert operations/);
  assert.deepEqual(known.snapshot(), knownSnapshot);

  const deferred = new SequenceDocument("deferred");
  deferred.apply({
    kind: "insert", id: "writer:1", actor: "writer", counter: 1,
    after: "anchor:1", value: "X",
  });
  const deferredSnapshot = deferred.snapshot();
  assert.throws(() => deferred.apply({
    kind: "delete", id: "anchor:1", actor: "anchor", counter: 1, target: "writer:1",
  }), /referenced as an insert cannot resolve to a delete/);
  assert.deepEqual(deferred.snapshot(), deferredSnapshot);

  deferred.apply({
    kind: "insert", id: "anchor:1", actor: "anchor", counter: 1,
    after: "ROOT", value: "A",
  });
  assert.equal(deferred.toString(), "AX");
});

test("three replicas converge after shuffled offline edits", () => {
  const alice = new SequenceDocument("alice");
  const initial = alice.localInsert(0, "notes");
  const bob = SequenceDocument.fromSnapshot("bob", alice.snapshot());
  const carol = SequenceDocument.fromSnapshot("carol", alice.snapshot());
  const edits: Operation[] = [
    ...alice.localInsert(5, "!"),
    ...bob.localInsert(0, "My "),
    ...carol.localDelete(1, 2),
  ];

  alice.merge([...edits].reverse());
  bob.merge([edits[2], edits[0], edits[5], edits[3], edits[1], edits[4], ...initial]);
  carol.merge([edits[1], edits[4], edits[0], edits[5], edits[2], edits[3], ...initial]);
  assert.equal(alice.toString(), bob.toString());
  assert.equal(bob.toString(), carol.toString());
  assert.deepEqual(alice.versionVector(), bob.versionVector());
  assert.deepEqual(bob.versionVector(), carol.versionVector());
});

test("snapshots restore tombstones and support new local edits", () => {
  const alice = new SequenceDocument("alice");
  alice.localInsert(0, "draft");
  alice.localDelete(0, 1);

  const restored = SequenceDocument.fromSnapshot("bob", alice.snapshot());
  assert.equal(restored.toString(), "raft");
  restored.localInsert(0, "D");
  assert.equal(restored.toString(), "Draft");
});

test("seeded randomized offline deliveries converge across four replicas", () => {
  let seed = 0x5EED1234;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
  const shuffle = <T>(values: T[]): T[] => {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const selected = Math.floor(random() * (index + 1));
      [copy[index], copy[selected]] = [copy[selected], copy[index]];
    }
    return copy;
  };

  for (let scenario = 0; scenario < 25; scenario += 1) {
    const source = new SequenceDocument(`source-${scenario}`);
    const initial = source.localInsert(0, "shared");
    const replicas = ["alice", "bob", "carol", "dave"].map((name) => {
      const replica = new SequenceDocument(`${name}-${scenario}`);
      replica.merge(initial);
      return replica;
    });
    const offlineOperations: Operation[] = [];
    for (const [replicaIndex, replica] of replicas.entries()) {
      for (let edit = 0; edit < 8; edit += 1) {
        if (replica.length > 1 && random() < 0.35) {
          const index = Math.floor(random() * replica.length);
          offlineOperations.push(...replica.localDelete(index, 1));
        } else {
          const index = Math.floor(random() * (replica.length + 1));
          offlineOperations.push(...replica.localInsert(index, String(replicaIndex)));
        }
      }
    }
    for (const replica of replicas) replica.merge(shuffle(offlineOperations));
    assert.ok(replicas.every((replica) => replica.toString() === replicas[0].toString()));
    for (const replica of replicas) {
      assert.deepEqual(replica.versionVector(), replicas[0].versionVector());
    }
  }
});

test("invalid indices and malformed remote operations are rejected", () => {
  const document = new SequenceDocument("alice");
  assert.throws(() => document.localInsert(1, "A"), /outside the document/);
  assert.throws(() => document.localDelete(0, -1), /non-negative/);
  assert.throws(() => document.apply({
    kind: "insert", id: "mallory:1", actor: "mallory", counter: 2, after: "ROOT", value: "X",
  }), /does not match/);
  assert.throws(() => document.apply({
    kind: "insert", id: "mallory:1", actor: "mallory", counter: 1, after: "ROOT", value: 7,
  } as unknown as Operation), /one grapheme/);
  assert.throws(() => document.apply({
    kind: "insert", id: "7:1", actor: 7, counter: 1, after: "ROOT", value: "X",
  } as unknown as Operation), /actor or counter/);
  assert.throws(() => document.apply({
    kind: "delete", id: "mallory:2", actor: "mallory", counter: 2, target: 7,
  } as unknown as Operation), /delete operation target/);
  assert.equal(document.toString(), "");
});
