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
  assert.equal(receiver.apply(operation), false);
  assert.equal(receiver.toString(), "A");
  assert.throws(() => receiver.apply({ ...operation, value: "B" }), /conflicting operation/);
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

test("invalid indices and malformed remote operations are rejected", () => {
  const document = new SequenceDocument("alice");
  assert.throws(() => document.localInsert(1, "A"), /outside the document/);
  assert.throws(() => document.localDelete(0, -1), /non-negative/);
  assert.throws(() => document.apply({
    kind: "insert", id: "mallory:1", actor: "mallory", counter: 2, after: "ROOT", value: "X",
  }), /does not match/);
});
