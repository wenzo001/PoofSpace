import { decodeRoomId, decodeSecret, encodeRoomId, encodeSecret } from '../crypto/invite';

const KEY = 'poofspace.vault.v1';

export interface VaultEntry {
  roomId: string;
  /** Base64url invite secret: the minimum credential needed to re-enter the room. */
  secret: string;
  creatorToken?: string;
  /** Online count the last time this device was inside. A snapshot, never a live figure: reading
   *  it must not cost a join, because joining would cancel the room's idle-destroy countdown. */
  lastOnline?: number;
  savedAt: number;
  lastUsed: number;
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function toEntry(raw: unknown): VaultEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.roomId !== 'string' || typeof o.secret !== 'string') return null;
  try {
    return {
      roomId: encodeRoomId(decodeRoomId(o.roomId)),
      secret: encodeSecret(decodeSecret(o.secret)),
      creatorToken: typeof o.creatorToken === 'string' ? o.creatorToken : undefined,
      lastOnline: typeof o.lastOnline === 'number' && o.lastOnline >= 0 ? o.lastOnline : undefined,
      savedAt: typeof o.savedAt === 'number' ? o.savedAt : Date.now(),
      lastUsed: typeof o.lastUsed === 'number' ? o.lastUsed : Date.now()
    };
  } catch {
    return null;
  }
}

export function list(): VaultEntry[] {
  const s = storage();
  if (!s) return [];
  let items: unknown;
  try {
    items = JSON.parse(s.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const out: VaultEntry[] = [];
  for (const raw of items) {
    const e = toEntry(raw);
    if (e) out.push(e);
  }
  out.sort((a, b) => b.lastUsed - a.lastUsed);
  return out;
}

function persist(entries: VaultEntry[]): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* storage unavailable: recovery entries stay best-effort */
  }
}

/** Re-decodes the stored credential so callers never keep the base64url text around. */
export function secretOf(entry: VaultEntry): Uint8Array {
  return decodeSecret(entry.secret);
}

export function normalizeRoomId(roomId: string): string | null {
  try {
    return encodeRoomId(decodeRoomId(roomId));
  } catch {
    return null;
  }
}

export function get(roomId: string): VaultEntry | null {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  return list().find((e) => e.roomId === id) ?? null;
}

export function put(input: { roomId: string; secret: Uint8Array; creatorToken?: string }): VaultEntry | null {
  const id = normalizeRoomId(input.roomId);
  if (!id) return null;
  const now = Date.now();
  const entry: VaultEntry = {
    roomId: id,
    secret: encodeSecret(input.secret),
    creatorToken: input.creatorToken,
    savedAt: now,
    lastUsed: now
  };
  persist([...list().filter((e) => e.roomId !== id), entry]);
  return entry;
}

export function remove(roomId: string): void {
  const id = normalizeRoomId(roomId);
  if (!id) return;
  persist(list().filter((e) => e.roomId !== id));
}

export function touch(roomId: string): void {
  const entries = list();
  const hit = entries.find((e) => e.roomId === roomId);
  if (!hit) return;
  hit.lastUsed = Date.now();
  persist(entries);
}

/**
 * Records how many members were connected the last time this device was inside, so the home page
 * can say something true about a room without opening a socket to ask — asking would join, and
 * joining would cancel the room's idle-destroy countdown.
 */
export function noteOnline(roomId: string, online: number): void {
  const id = normalizeRoomId(roomId);
  if (!id || !Number.isFinite(online) || online < 0) return;
  const entries = list();
  const hit = entries.find((e) => e.roomId === id);
  if (!hit) return;
  hit.lastOnline = Math.floor(online);
  persist(entries);
}
