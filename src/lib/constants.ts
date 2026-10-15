export const PROTO_VERSION = 1 as const;
export const PROTO_TAG = 'v1';

export const ROOM_ID_BYTES = 16;
export const ROOM_SECRET_BYTES = 32;
export const SERVER_CHALLENGE_BYTES = 32;
export const CREATOR_TOKEN_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export const MAX_SLOT = 0xffffff;
export const MAX_GEN = 0xffff;
export const MAX_COUNTER = 0xffffffffffff;

export type RoomStatus = 'ACTIVE' | 'IDLE_GRACE' | 'DESTROYING' | 'DESTROYED';

/** Why a room was destroyed: the creator asked, the recovery window ran out, the process is
 *  shutting down, or the local operator drove every room out. */
export type RoomDestroyReason = 'creator' | 'idle' | 'shutdown' | 'admin';

/** Statuses that still hold a room slot: they own ciphertext on disk. */
export const SLOT_HOLDING_STATUSES: readonly RoomStatus[] = ['ACTIVE', 'IDLE_GRACE', 'DESTROYING'];

export const LIMITS = {
  maxMembersDefault: 100,
  maxMembersHard: 500,
  minMembers: 1,

  // Node-wide room capacity: ACTIVE + IDLE_GRACE + DESTROYING all hold a slot, because all
  // three still own ciphertext on disk. Env-tunable and validated at startup.
  maxRoomsDefault: 20,
  maxRoomsHard: 1000,
  // The last participant leaving does not destroy the room: a refresh, a device switch or a
  // network blip must be survivable, so the room sits in IDLE_GRACE for exactly this long.
  roomIdleTtlSeconds: 300,
  roomIdleTtlMaxSeconds: 86_400,

  connectionsNodeMax: 4000,
  connectionsPerIpMax: 512,
  tempBytesMaxNode: 20 * 1024 * 1024 * 1024,
  // Freed pages may still carry ciphertext of a destroyed room until VACUUM rewrites them.
  vacuumFreelistPages: 4096,
  destroyRetryMs: 10_000,

  textPlaintextBytes: 64 * 1024,
  textCiphertextBytes: 96 * 1024,

  nickChars: 32,
  historyPageSize: 50,
  historyPageMax: 200,
  syncGapMax: 5000,

  messagesPerRoomHard: 200_000,

  chunkBytes: 1024 * 1024,
  chunkBytesMax: 4 * 1024 * 1024,
  attachmentBytesMax: 256 * 1024 * 1024,
  roomAttachmentBytesMax: 2 * 1024 * 1024 * 1024,
  uploadConcurrencyMax: 4,
  pendingUploadsPerMember: 8,
  uploadBufferBytes: 8 * 1024 * 1024,

  msgPerSecond: 20,
  msgBurst: 40,

  heartbeatClientMs: 15_000,
  heartbeatServerMs: 15_000,
  // The grace must outlast several client intervals: a mobile tab whose timers are throttled
  // in background is still a member, and reaping it would silently evict a live participant.
  heartbeatGraceMs: 60_000,
  slotGraceMs: 45_000,

  pendingUploadTtlMs: 30 * 60 * 1000,
  wsSendBufferBytes: 4 * 1024 * 1024,
  wsOutboxMax: 512
};

export const HKDF_INFO = {
  msg: 'poofspace/v1/msg',
  file: 'poofspace/v1/file',
  meta: 'poofspace/v1/meta',
  authVerifier: 'poofspace/v1/authver',
  join: 'poofspace/v1/join'
} as const;

export const ERR = {
  roomNotFound: 'ROOM_NOT_FOUND',
  roomDestroyed: 'ROOM_DESTROYED',
  roomDestroying: 'ROOM_DESTROYING',
  roomFull: 'ROOM_FULL',
  capacityFull: 'ROOM_CAPACITY_FULL',
  maintenance: 'MAINTENANCE',
  badProof: 'BAD_PROOF',
  badSecret: 'BAD_SECRET',
  decryptFailed: 'DECRYPT_FAILED',
  authFailed: 'AUTH_FAILED',
  notMember: 'NOT_MEMBER',
  notCreator: 'NOT_CREATOR',
  cryptoUnavailable: 'CRYPTO_UNAVAILABLE',
  rateLimited: 'RATE_LIMITED',
  tooLarge: 'TOO_LARGE',
  badState: 'BAD_STATE',
  storageFull: 'STORAGE_FULL',
  attachmentNotFound: 'ATTACHMENT_NOT_FOUND',
  uploadNotFound: 'UPLOAD_NOT_FOUND',
  invalidNonce: 'INVALID_NONCE',
  nonceReuse: 'NONCE_REUSE'
} as const;

/**
 * Join refusals that will still be true on the next attempt: the room is gone, or the secret is
 * not the one it was created with. One list, because a client that retries these is a client that
 * hammers a dead room id forever, and a UI that shows "try again" is lying.
 */
export const TERMINAL_JOIN_CODES: readonly string[] = [
  ERR.roomNotFound,
  ERR.roomDestroyed,
  ERR.roomDestroying,
  ERR.badProof,
  ERR.badSecret
];
