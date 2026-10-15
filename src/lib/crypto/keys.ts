import { HKDF_INFO, ROOM_SECRET_BYTES } from '../constants';
import { utf8 } from '../encoding';
import { hkdfSha256, hmacSha256 } from './engine';

export interface RoomKeys {
  readonly msgKey: Uint8Array;
  readonly fileKey: Uint8Array;
  readonly metaKey: Uint8Array;
  readonly joinKey: Uint8Array;
}

/**
 * The room secret never leaves the browser. `authVerifier` is an intermediate HKDF
 * output that stays client-side too; only `joinKey` (an HMAC over it) is handed to
 * the server, which needs it to check possession of the invite without ever being
 * able to derive msgKey/fileKey/metaKey.
 */
export function deriveRoomKeys(secret: Uint8Array): RoomKeys {
  if (secret.length !== ROOM_SECRET_BYTES) throw new Error('room secret must be 32 bytes');
  const authVerifier = hkdfSha256(secret, HKDF_INFO.authVerifier, 32);
  return {
    msgKey: hkdfSha256(secret, HKDF_INFO.msg, 32),
    fileKey: hkdfSha256(secret, HKDF_INFO.file, 32),
    metaKey: hkdfSha256(secret, HKDF_INFO.meta, 32),
    joinKey: hmacSha256(authVerifier, utf8(HKDF_INFO.join))
  };
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function computeJoinProof(joinKey: Uint8Array, roomId: string, challenge: Uint8Array): Uint8Array {
  return hmacSha256(joinKey, utf8(`${HKDF_INFO.join}|${roomId}|${toHex(challenge)}`));
}
