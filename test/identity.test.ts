import assert from "node:assert/strict";
import { test } from "node:test";
import { loadIdentity, saveIdentity } from "../web/identity.ts";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    value: () => value,
  };
}

test("a valid stored presence identity is restored without regeneration", () => {
  const stored = { userId: "user-1", name: "Ada", color: "#7C3AED" };
  const storage = memoryStorage(JSON.stringify(stored));
  let generated = false;
  const restored = loadIdentity({
    storage,
    randomUUID: () => { generated = true; return "unused"; },
  });

  assert.deepEqual(restored, stored);
  assert.equal(generated, false);
});

test("corrupt or invalid stored identities are replaced with a safe profile", () => {
  for (const invalid of ["{broken", JSON.stringify({ userId: "bad id", name: "", color: "red" })]) {
    const storage = memoryStorage(invalid);
    const restored = loadIdentity({
      storage,
      randomUUID: () => "abcd-1234",
      random: () => 0,
    });

    assert.deepEqual(restored, { userId: "abcd-1234", name: "Guest ABCD", color: "#7C3AED" });
    assert.deepEqual(JSON.parse(storage.value()!), restored);
  }
});

test("blocked browser storage does not prevent an in-memory identity", () => {
  const storage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
  const restored = loadIdentity({
    storage,
    randomUUID: () => "offline-user",
    random: () => 0.99,
  });

  assert.equal(restored.userId, "offline-user");
  assert.equal(restored.color, "#4F46E5");
  assert.equal(saveIdentity(restored, storage), false);
});
