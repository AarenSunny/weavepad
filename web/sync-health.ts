export type ConnectionStatus = "connecting" | "online" | "offline";

export function reconnectDelayMs(failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    throw new Error("failedAttempts must be a positive integer");
  }
  return Math.min(1_000 * 2 ** (failedAttempts - 1), 10_000);
}

export function syncProgressLabel(status: ConnectionStatus, pendingOperations: number): string {
  if (!Number.isInteger(pendingOperations) || pendingOperations < 0) {
    throw new Error("pendingOperations must be a non-negative integer");
  }
  if (status === "offline") {
    return pendingOperations > 0
      ? `Offline · ${pendingOperations} ${pendingOperations === 1 ? "change" : "changes"} waiting`
      : "Offline · local copy available";
  }
  if (status === "connecting") {
    return pendingOperations > 0
      ? `${pendingOperations} ${pendingOperations === 1 ? "change" : "changes"} waiting to sync`
      : "Connecting to sync service";
  }
  return pendingOperations > 0
    ? `${pendingOperations} ${pendingOperations === 1 ? "change" : "changes"} syncing`
    : "All changes synced";
}

export function recentTimeLabel(timestamp: number | null, now = Date.now()): string {
  if (timestamp === null) return "Not yet";
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (elapsedSeconds < 5) return "Just now";
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  return elapsedMinutes === 1 ? "1 min ago" : `${elapsedMinutes} min ago`;
}
