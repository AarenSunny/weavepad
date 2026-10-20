import type { PresenceProfile } from "../src/presence.ts";
import { AVATAR_COLORS } from "./color-contrast.ts";

const STORAGE_KEY = "weavepad.identity";
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

type IdentityStorage = Pick<Storage, "getItem" | "setItem">;

interface IdentityOptions {
  storage?: IdentityStorage;
  randomUUID?: () => string;
  random?: () => number;
}

function isPresenceProfile(value: unknown): value is PresenceProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<PresenceProfile>;
  return typeof profile.userId === "string"
    && USER_ID_PATTERN.test(profile.userId)
    && typeof profile.name === "string"
    && profile.name.trim().length >= 1
    && profile.name.length <= 80
    && typeof profile.color === "string"
    && COLOR_PATTERN.test(profile.color);
}

function browserStorage(): IdentityStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function saveIdentity(
  profile: PresenceProfile,
  storage?: IdentityStorage,
): boolean {
  try {
    const target = storage ?? browserStorage();
    if (!target) return false;
    target.setItem(STORAGE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function loadIdentity(options: IdentityOptions = {}): PresenceProfile {
  const storage = options.storage ?? browserStorage();
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (isPresenceProfile(parsed)) {
        return { userId: parsed.userId, name: parsed.name, color: parsed.color };
      }
    }
  } catch {
    // A fresh in-memory identity keeps the editor usable when storage is blocked or corrupt.
  }

  const userId = (options.randomUUID ?? (() => crypto.randomUUID()))();
  const colorIndex = Math.floor((options.random ?? Math.random)() * AVATAR_COLORS.length);
  const profile = {
    userId,
    name: `Guest ${userId.slice(0, 4).toUpperCase()}`,
    color: AVATAR_COLORS[colorIndex] ?? AVATAR_COLORS[0],
  };
  saveIdentity(profile, storage);
  return profile;
}
