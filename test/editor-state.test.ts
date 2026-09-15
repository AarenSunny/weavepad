import assert from "node:assert/strict";
import { test } from "node:test";
import { SequenceDocument } from "../src/crdt.ts";
import { applyTextChange, cursorAnchor } from "../web/editor-state.ts";

test("text changes become the smallest contiguous CRDT edit", () => {
  const document = new SequenceDocument("alice");
  document.localInsert(0, "The cat sat.");
  const operations = applyTextChange(document, "The cat sat.", "The dog sat.");

  assert.equal(document.toString(), "The dog sat.");
  assert.equal(operations.filter((operation) => operation.kind === "delete").length, 3);
  assert.equal(operations.filter((operation) => operation.kind === "insert").length, 3);
});

test("editor diffs and cursor anchors respect emoji grapheme boundaries", () => {
  const document = new SequenceDocument("alice");
  document.localInsert(0, "A👩🏽‍💻B");
  assert.equal(cursorAnchor(document, document.toString(), "A👩🏽‍💻".length), "alice:2");

  applyTextChange(document, "A👩🏽‍💻B", "A✨B");
  assert.equal(document.toString(), "A✨B");
  assert.equal(document.length, 3);
});

test("unchanged editor text emits no operations", () => {
  const document = new SequenceDocument("alice");
  document.localInsert(0, "steady");
  assert.deepEqual(applyTextChange(document, "steady", "steady"), []);
});
