import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { sendWithBufferLimit } from "../src/server.ts";

function socket(bufferedAmount: number) {
  const sent: string[] = [];
  let terminated = false;
  return {
    target: {
      readyState: WebSocket.OPEN,
      bufferedAmount,
      send: (message: string) => sent.push(message),
      terminate: () => { terminated = true; },
    },
    sent,
    terminated: () => terminated,
  };
}

test("outbound sends enforce byte-accurate per-connection buffering", () => {
  const healthy = socket(0);
  assert.equal(sendWithBufferLimit(healthy.target, { value: "ok" }, 64), "sent");
  assert.deepEqual(healthy.sent, ['{"value":"ok"}']);
  assert.equal(healthy.terminated(), false);

  const slow = socket(55);
  assert.equal(sendWithBufferLimit(slow.target, { value: "ok" }, 64), "backpressure");
  assert.deepEqual(slow.sent, []);
  assert.equal(slow.terminated(), true);

  const unicode = socket(0);
  const encoded = JSON.stringify({ value: "✨" });
  assert.ok(Buffer.byteLength(encoded) > encoded.length);
  assert.equal(
    sendWithBufferLimit(unicode.target, { value: "✨" }, encoded.length),
    "backpressure",
  );
  assert.equal(unicode.terminated(), true);
});
