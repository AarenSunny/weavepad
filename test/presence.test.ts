import assert from "node:assert/strict";
import { test } from "node:test";
import { PresenceManager, type PresenceSnapshot } from "../src/presence.ts";

const alice = { userId: "alice", name: "Alice", color: "#7c3aed" };

test("presence publishes immutable, revisioned room snapshots", () => {
  let now = 1_000;
  const manager = new PresenceManager({ ttlMs: 5_000, now: () => now });
  const received: PresenceSnapshot[] = [];
  manager.subscribe("design", (snapshot) => received.push(snapshot));

  const joined = manager.update("design", "session-a", alice, { anchor: "ROOT", focus: "ROOT" });
  assert.equal(joined.revision, 1);
  assert.equal(joined.participants[0].lastSeen, 1_000);
  assert.equal(joined.participants[0].color, "#7C3AED");

  joined.participants[0].name = "mutated copy";
  now = 1_500;
  manager.update("design", "session-a", alice, { anchor: "alice:1", focus: "alice:2" });
  assert.equal(received.at(-1)?.participants[0].name, "Alice");
  assert.deepEqual(received.at(-1)?.participants[0].selection, { anchor: "alice:1", focus: "alice:2" });
});

test("heartbeats extend a session without creating noisy roster events", () => {
  let now = 0;
  const manager = new PresenceManager({ ttlMs: 5_000, now: () => now });
  let events = 0;
  manager.subscribe("design", () => events += 1);
  manager.update("design", "session-a", alice, null);

  now = 4_000;
  assert.equal(manager.heartbeat("design", "session-a"), true);
  assert.equal(events, 1);
  now = 7_000;
  assert.equal(manager.sweepExpired(), 0);
  assert.equal(manager.snapshot("design").participants.length, 1);
});

test("expired sessions are removed together in one new revision", () => {
  let now = 0;
  const manager = new PresenceManager({ ttlMs: 5_000, now: () => now });
  manager.update("design", "session-a", alice, null);
  manager.update("design", "session-b", { ...alice, userId: "bob", name: "Bob" }, null);

  now = 5_001;
  assert.equal(manager.sweepExpired(), 2);
  const snapshot = manager.snapshot("design");
  assert.equal(snapshot.revision, 3);
  assert.deepEqual(snapshot.participants, []);
});

test("invalid profiles and cursor anchors are rejected", () => {
  const manager = new PresenceManager();
  assert.throws(
    () => manager.update("design", "session-a", { ...alice, color: "purple" }, null),
    /hex color/,
  );
  assert.throws(
    () => manager.update("design", "session-a", alice, { anchor: "numeric-index", focus: null }),
    /CRDT operation/,
  );
  assert.equal(manager.snapshot("design").participants.length, 0);
});
