import { validateDocumentId } from "./store.ts";

export interface PresenceProfile {
  userId: string;
  name: string;
  color: string;
}

export interface PresenceSelection {
  anchor: string | null;
  focus: string | null;
}

export interface PresenceParticipant extends PresenceProfile {
  sessionId: string;
  selection: PresenceSelection | null;
  lastSeen: number;
}

export interface PresenceSnapshot {
  type: "presence";
  documentId: string;
  revision: number;
  participants: PresenceParticipant[];
}

type PresenceSubscriber = (snapshot: PresenceSnapshot) => void;

interface PresenceRoom {
  revision: number;
  participants: Map<string, PresenceParticipant>;
  subscribers: Set<PresenceSubscriber>;
}

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const POSITION_PATTERN = /^(ROOT|[A-Za-z0-9_-]{1,64}:[1-9][0-9]*)$/;

function validateProfile(profile: PresenceProfile): void {
  if (!profile || !USER_ID_PATTERN.test(profile.userId)) {
    throw new Error("presence userId must contain 1-128 letters, numbers, underscores, or hyphens");
  }
  if (typeof profile.name !== "string" || profile.name.trim().length < 1 || profile.name.length > 80) {
    throw new Error("presence name must contain 1-80 characters");
  }
  if (!COLOR_PATTERN.test(profile.color)) {
    throw new Error("presence color must be a six-digit hex color");
  }
}

function validateSelection(selection: PresenceSelection | null): void {
  if (selection === null) return;
  if (!selection || !("anchor" in selection) || !("focus" in selection)) {
    throw new Error("presence selection must include anchor and focus");
  }
  for (const position of [selection.anchor, selection.focus]) {
    if (position !== null && (typeof position !== "string" || !POSITION_PATTERN.test(position))) {
      throw new Error("presence positions must reference a CRDT operation or ROOT");
    }
  }
}

function cloneParticipant(participant: PresenceParticipant): PresenceParticipant {
  return {
    ...participant,
    selection: participant.selection ? { ...participant.selection } : null,
  };
}

export class PresenceManager {
  private readonly rooms = new Map<string, PresenceRoom>();
  private readonly now: () => number;
  readonly ttlMs: number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 30_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000) {
      throw new Error("presence TTL must be an integer of at least 1000ms");
    }
    this.now = options.now ?? Date.now;
  }

  update(
    documentId: string,
    sessionId: string,
    profile: PresenceProfile,
    selection: PresenceSelection | null,
  ): PresenceSnapshot {
    validateDocumentId(documentId);
    if (!USER_ID_PATTERN.test(sessionId)) throw new Error("invalid presence session id");
    validateProfile(profile);
    validateSelection(selection);
    const room = this.room(documentId);
    room.participants.set(sessionId, {
      sessionId,
      userId: profile.userId,
      name: profile.name.trim(),
      color: profile.color.toUpperCase(),
      selection: selection ? { ...selection } : null,
      lastSeen: this.now(),
    });
    return this.publish(documentId, room);
  }

  heartbeat(documentId: string, sessionId: string): boolean {
    const participant = this.room(documentId).participants.get(sessionId);
    if (!participant) return false;
    participant.lastSeen = this.now();
    return true;
  }

  leave(documentId: string, sessionId: string): boolean {
    const room = this.room(documentId);
    if (!room.participants.delete(sessionId)) return false;
    this.publish(documentId, room);
    return true;
  }

  sweepExpired(): number {
    const deadline = this.now() - this.ttlMs;
    let removed = 0;
    for (const [documentId, room] of this.rooms) {
      let changed = false;
      for (const [sessionId, participant] of room.participants) {
        if (participant.lastSeen <= deadline) {
          room.participants.delete(sessionId);
          removed += 1;
          changed = true;
        }
      }
      if (changed) this.publish(documentId, room);
    }
    return removed;
  }

  snapshot(documentId: string): PresenceSnapshot {
    const room = this.room(documentId);
    return this.makeSnapshot(documentId, room);
  }

  subscribe(documentId: string, subscriber: PresenceSubscriber): () => void {
    const room = this.room(documentId);
    room.subscribers.add(subscriber);
    return () => room.subscribers.delete(subscriber);
  }

  private room(documentId: string): PresenceRoom {
    validateDocumentId(documentId);
    const existing = this.rooms.get(documentId);
    if (existing) return existing;
    const room = {
      revision: 0,
      participants: new Map<string, PresenceParticipant>(),
      subscribers: new Set<PresenceSubscriber>(),
    };
    this.rooms.set(documentId, room);
    return room;
  }

  private publish(documentId: string, room: PresenceRoom): PresenceSnapshot {
    room.revision += 1;
    const snapshot = this.makeSnapshot(documentId, room);
    for (const subscriber of room.subscribers) subscriber(snapshot);
    return snapshot;
  }

  private makeSnapshot(documentId: string, room: PresenceRoom): PresenceSnapshot {
    return {
      type: "presence",
      documentId,
      revision: room.revision,
      participants: Array.from(room.participants.values(), cloneParticipant)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
    };
  }
}
