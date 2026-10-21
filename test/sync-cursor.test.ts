import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceSyncCursor } from "../web/sync-cursor.ts";

test("sync cursors advance monotonically across data and acknowledgement messages", () => {
  assert.equal(advanceSyncCursor(4, 9), 9);
  assert.equal(advanceSyncCursor(9, 9), 9);
  assert.equal(advanceSyncCursor(9, 3), 9);
});

test("sync cursors reject values that cannot be persisted safely", () => {
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "9", null]) {
    assert.throws(() => advanceSyncCursor(0, invalid), /received sync cursor/);
  }
  assert.throws(() => advanceSyncCursor(Number.NaN, 1), /current sync cursor/);
});
