import { bytesToB64url, b64urlToBytes, concatBytes, randomBytes } from '../encoding';
import { ROOM_ID_BYTES, ROOM_SECRET_BYTES } from '../constants';
import { base32Decode, base32Encode, group } from '../base32';

export interface InviteParts {
  roomId: string;
  secret: Uint8Array;
}

export function newRoomIdBytes(): Uint8Array {
  return randomBytes(ROOM_ID_BYTES);
}

export function newSecretBytes(): Uint8Array {
  return randomBytes(ROOM_SECRET_BYTES);
}

/** Canonical room id: lowercase base32 of 16 random bytes (128 bits of entropy). */
export function encodeRoomId(bytes: Uint8Array): string {
  if (bytes.length !== ROOM_ID_BYTES) throw new Error('room id must be 16 bytes');
  return base32Encode(bytes);
}

export function decodeRoomId(id: string): Uint8Array {
  // Room ids are base32, so '-', '.' and spaces are unambiguous display separators.
  const raw = id.replace(/[\s.\-–—_]/g, '').toLowerCase();
  const bytes = base32Decode(raw);
  if (bytes.length !== ROOM_ID_BYTES) throw new Error('room id has wrong length');
  return bytes;
}

/**
 * Invite codes are base64url, whose alphabet already contains '-' and '_'; only
 * whitespace may be stripped or a valid code silently turns into garbage.
 */
export function normalizeCode(s: string): string {
  return s.replace(/\s+/g, '');
}

export function displayRoomId(id: string): string {
  return group(encodeRoomId(decodeRoomId(id)), 5);
}

export function encodeSecret(secret: Uint8Array): string {
  return bytesToB64url(secret);
}

export function decodeSecret(fragment: string): Uint8Array {
  const bytes = b64urlToBytes(fragment.trim());
  if (bytes.length !== ROOM_SECRET_BYTES) {
    throw new Error(`invite secret must be ${ROOM_SECRET_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Text form of an invite: 48 random bytes (roomId || secret) in one pasteable token. */
export function makeInviteCode(parts: InviteParts): string {
  return bytesToB64url(concatBytes(decodeRoomId(parts.roomId), parts.secret));
}

export function parseInviteCode(code: string): InviteParts {
  const bytes = b64urlToBytes(normalizeCode(code));
  if (bytes.length !== ROOM_ID_BYTES + ROOM_SECRET_BYTES) throw new Error('invite code has wrong length');
  return {
    roomId: encodeRoomId(bytes.subarray(0, ROOM_ID_BYTES)),
    secret: bytes.subarray(ROOM_ID_BYTES)
  };
}

export function buildInviteLink(origin: string, parts: InviteParts): string {
  const clean = origin.replace(/\/+$/, '');
  return `${clean}/room/${parts.roomId}#${encodeSecret(parts.secret)}`;
}

/**
 * Accepts a full invite URL, a bare `roomId#secret` pair, or the pasteable invite
 * code. The fragment is never sent to the server, so callers must keep it local.
 */
export function parseInviteInput(input: string): InviteParts | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.includes('#')) {
      const hashIndex = trimmed.indexOf('#');
      const before = trimmed.slice(0, hashIndex);
      const fragment = trimmed.slice(hashIndex + 1);
      const roomIdRaw = before.includes('/') ? before.slice(before.lastIndexOf('/') + 1) : before;
      const roomId = encodeRoomId(decodeRoomId(roomIdRaw));
      return { roomId, secret: decodeSecret(fragment) };
    }
    const cleaned = normalizeCode(trimmed);
    if (cleaned.length === 64) return parseInviteCode(cleaned);
    return null;
  } catch {
    return null;
  }
}

/** A canonical room id round-trips through encode/decode; variants are rejected. */
export function isCanonicalRoomId(id: string): boolean {
  try {
    return encodeRoomId(decodeRoomId(id)) === id;
  } catch {
    return false;
  }
}

export function wsUrlFromLocation(href: string): string {
  const u = new URL(href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}
