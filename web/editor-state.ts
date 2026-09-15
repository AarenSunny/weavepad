import { SequenceDocument, splitGraphemes, type Operation } from "../src/crdt.ts";

export function applyTextChange(
  document: SequenceDocument,
  previousText: string,
  nextText: string,
): Operation[] {
  const before = splitGraphemes(previousText);
  const after = splitGraphemes(nextText);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = before.length - prefix - suffix;
  const inserted = after.slice(prefix, after.length - suffix).join("");
  return [
    ...document.localDelete(prefix, removed),
    ...document.localInsert(prefix, inserted),
  ];
}

export function cursorAnchor(document: SequenceDocument, text: string, codeUnitOffset: number): string {
  const safeOffset = Math.max(0, Math.min(codeUnitOffset, text.length));
  return document.anchorAt(splitGraphemes(text.slice(0, safeOffset)).length);
}
