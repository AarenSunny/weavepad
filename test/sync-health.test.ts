import assert from "node:assert/strict";
import { test } from "node:test";
import { recentTimeLabel, reconnectDelayMs, syncProgressLabel } from "../web/sync-health.ts";

test("reconnect backoff starts promptly and caps at ten seconds", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(reconnectDelayMs), [1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  assert.throws(() => reconnectDelayMs(0), /positive integer/);
});

test("sync progress distinguishes online, reconnecting, and offline work", () => {
  assert.equal(syncProgressLabel("online", 0), "All changes synced");
  assert.equal(syncProgressLabel("online", 2), "2 changes syncing");
  assert.equal(syncProgressLabel("connecting", 1), "1 change waiting to sync");
  assert.equal(syncProgressLabel("offline", 3), "Offline · 3 changes waiting");
  assert.equal(syncProgressLabel("offline", 0), "Offline · local copy available");
});

test("recent timestamps use stable user-facing buckets", () => {
  const now = 100_000;
  assert.equal(recentTimeLabel(null, now), "Not yet");
  assert.equal(recentTimeLabel(now - 2_000, now), "Just now");
  assert.equal(recentTimeLabel(now - 20_000, now), "20s ago");
  assert.equal(recentTimeLabel(now - 60_000, now), "1 min ago");
});
