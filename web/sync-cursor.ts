export function advanceSyncCursor(current: number, received: unknown): number {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error("current sync cursor must be a non-negative integer");
  }
  if (typeof received !== "number" || !Number.isSafeInteger(received) || received < 0) {
    throw new Error("received sync cursor must be a non-negative integer");
  }
  return Math.max(current, received);
}
