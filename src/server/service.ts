import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { AppConfig } from './config';
import type { Db, RoomRow } from './db';
import type { RoomStorage } from './storage';
import { ERR, IDLE_DELAY_CHOICES_MS, LIMITS, SLOT_HOLDING_STATUSES, type RoomDestroyReason, type RoomStatus } from '../lib/constants';
import { isCanonicalRoomId } from '../lib/crypto/invite';
import type { AttachmentIndex, MemberDto, MessageDto } from '../lib/proto';
import { logger } from './log';

// Slot ids are packed into 3 bytes of every message nonce, so they must stay well below
// 2^24. Released slots are reused first, so a room's ids stay bounded by its own member cap.
const MAX_SLOT = 0xff_ffff;

export interface JoinInput {
  roomId: string;
  proof: Uint8Array;
  nick: Uint8Array;
  nickNonce: Uint8Array;
}

export interface JoinResult {
  ok: boolean;
  code?: string;
  slot?: number;
  gen?: number;
  headSeq?: number;
  oldestSeq?: number;
  isCreator?: boolean;
  sessionToken?: string;
  members?: MemberDto[];
}

export interface AppendInput {
  roomId: string;
  slot: number;
  gen: number;
  clientMsgId: string;
  kind: 'text' | 'file' | 'image';
  nonce: Uint8Array;
  ct: Uint8Array;
  attachmentId?: string;
}

export interface AppendResult {
  ok: boolean;
  code?: string;
  seq?: number;
  dup?: boolean;
  at?: number;
  clientMsgId?: string;
}

export type DestroyReason = RoomDestroyReason;

export interface DestroyReport {
  roomId: string;
  reason: string;
  files: number;
  bytes: number;
  rows: { messages: number; attachments: number; chunks: number; slots: number; tokens: number };
  verifiedEmpty: boolean;
  /** Files still present under the room directory when cleanup gave up for now. */
  residualFiles: number;
  /** 1 for the first attempt; the sweep keeps retrying an unfinished cleanup. */
  attempt: number;
  status: RoomStatus;
}

function emptyRowCounts() {
  return { messages: 0, attachments: 0, chunks: 0, slots: 0, tokens: 0 };
}

interface RoomMemory {
  connected: Map<number, { gen: number; lastSeen: number }>;
  buckets: Map<number, { tokens: number; refreshedAt: number }>;
}

const TOKEN_REFILL_PER_MS = LIMITS.msgPerSecond / 1000;

export class RoomService extends EventEmitter {
  private mem = new Map<string, RoomMemory>();
  /** Bounded: reports are for the operator's last command, not a room history ledger. */
  readonly destroyReports = new Map<string, DestroyReport>();
  private timers: NodeJS.Timeout[] = [];
  private paused = false;
  private destroyRetries = new Map<string, { reason: string; attempt: number; notBefore: number }>();

  constructor(
    private readonly db: Db,
    private readonly storage: RoomStorage,
    private readonly cfg: AppConfig
  ) {
    super();
    this.setMaxListeners(100);
  }

  /** Maintenance gate used by the local admin commands: refuse new rooms while cleaning. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  private rememberReport(roomId: string, report: DestroyReport): void {
    this.destroyReports.set(roomId, report);
    while (this.destroyReports.size > 64) {
      const oldest = this.destroyReports.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.destroyReports.delete(oldest);
    }
  }

  private memOf(roomId: string): RoomMemory {
    let m = this.mem.get(roomId);
    if (!m) {
      m = { connected: new Map(), buckets: new Map() };
      this.mem.set(roomId, m);
    }
    return m;
  }

  private q = {
    getRoom: (id: string) =>
      this.db.raw.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined,
    insertRoom: (id: string, joinKey: Uint8Array, creatorToken: Uint8Array, maxMembers: number, nextSlot: number, now: number) =>
      this.db.raw
        .prepare(
          `INSERT INTO rooms (id,status,join_key,creator_token,max_members,next_slot,head_seq,created_at,updated_at,attachment_bytes)
           VALUES (?,'ACTIVE',?,?,?,?,0,?,?,0)`
        )
        .run(id, joinKey, creatorToken, maxMembers, nextSlot, now, now),
    setStatus: (id: string, status: RoomStatus, now: number, reason: string | null) =>
      this.db.raw
        .prepare(
          `UPDATE rooms SET status=?, updated_at=?, destroy_reason=COALESCE(?, destroy_reason),
             destroyed_at=CASE WHEN ?='DESTROYED' THEN ? ELSE destroyed_at END
           WHERE id=? AND status<>?`
        )
        .run(status, now, reason, status, status === 'DESTROYED' ? now : null, id, status)
  };

  // ---------------------------------------------------------------- create

  createRoom(
    roomId: string,
    joinKey: Uint8Array,
    maxMembers: number
  ): { ok: true; creatorToken: string } | { ok: false; code: string } {
    if (this.paused) return { ok: false, code: ERR.maintenance };
    if (joinKey.length !== 32) throw new Error('join key must be 32 bytes');
    if (!isCanonicalRoomId(roomId)) throw new Error('room id must be canonical base32 of 16 bytes');
    const capped = Math.max(1, Math.min(maxMembers, this.cfg.maxMembersDefault, LIMITS.maxMembersHard));
    const creatorToken = crypto.randomBytes(32);
    const now = Date.now();
    // The room-count check and the INSERT share one transaction, and Node runs this handler
    // synchronously, so N concurrent creates cannot all pass the check before any of them lands.
    const outcome = this.db.tx<'ok' | string>(() => {
      if (this.slotsHeld() >= this.cfg.maxRooms) return ERR.capacityFull;
      this.q.insertRoom(roomId, joinKey, creatorToken, capped, 2, now);
      this.db.raw
        .prepare('INSERT INTO slots (room_id,slot,gen,is_creator,joined_at,last_seen,connected) VALUES (?,1,0,1,?,?,0)')
        .run(roomId, now, now);
      return 'ok' as const;
    });
    if (outcome !== 'ok') {
      logger.warn('room create refused at capacity', { maxRooms: this.cfg.maxRooms });
      return { ok: false, code: outcome };
    }
    // No per-room audit row is kept: creating a room is not logged with an identifier, because
    // the identifier plus a remembered fragment is half of the invite credential.
    return { ok: true, creatorToken: creatorToken.toString('base64url') };
  }

  /** Rooms that still occupy one of the node's `MAX_ROOMS` slots. */
  slotsHeld(): number {
    const placeholders = SLOT_HOLDING_STATUSES.map(() => '?').join(',');
    return (
      this.db.raw
        .prepare(`SELECT COUNT(*) c FROM rooms WHERE status IN (${placeholders})`)
        .get(...SLOT_HOLDING_STATUSES) as { c: number }
    ).c;
  }

  status(
    roomId: string
  ): { status: RoomStatus | 'UNKNOWN'; online: number; maxMembers: number; joinable: boolean } {
    const r = this.q.getRoom(roomId);
    if (!r) return { status: 'UNKNOWN', online: 0, maxMembers: 0, joinable: false };
    return {
      status: r.status,
      online: this.memOf(roomId).connected.size,
      maxMembers: r.max_members,
      joinable: r.status === 'ACTIVE' || r.status === 'IDLE_GRACE'
    };
  }

  // ------------------------------------------------------------------ join

  join(input: JoinInput, challenge: Uint8Array): JoinResult {
    const now = Date.now();
    if (this.paused) return { ok: false, code: ERR.maintenance };
    const room = this.q.getRoom(input.roomId);
    // A destroyed room has no row left, so it answers exactly like a room id that never existed:
    // the finer states are only revealed once the caller proves it holds the invite secret.
    if (!room) return { ok: false, code: ERR.roomNotFound };
    const expected = hmacJoin(room.join_key, input.roomId, challenge);
    if (expected.length !== input.proof.length || !crypto.timingSafeEqual(expected, Buffer.from(input.proof))) {
      return { ok: false, code: ERR.badProof };
    }
    if (room.status === 'DESTROYING') return { ok: false, code: ERR.roomDestroying };
    if (room.status === 'DESTROYED') return { ok: false, code: ERR.roomDestroyed };

    const mem = this.memOf(input.roomId);
    const result = this.db.tx(() => {
      const fresh = this.q.getRoom(input.roomId);
      if (!fresh || (fresh.status !== 'ACTIVE' && fresh.status !== 'IDLE_GRACE')) {
        return { code: ERR.roomDestroyed } as const;
      }
      if (fresh.status === 'IDLE_GRACE') {
        // Rejoining inside the recovery window cancels the countdown and returns *this* room:
        // same id, same head_seq, same ciphertext. It is not a freshly created room.
        this.db.raw
          .prepare("UPDATE rooms SET status='ACTIVE', empty_since=NULL, idle_delay_ms=NULL, updated_at=? WHERE id=?")
          .run(now, input.roomId);
      }
      const connected = this.db.raw
        .prepare('SELECT COUNT(*) c FROM slots WHERE room_id=? AND connected=1')
        .get(input.roomId) as { c: number };
      if (connected.c >= fresh.max_members) return { code: ERR.roomFull } as const;

      // Prefer the creator's own slot, then any released slot, so slot numbers stay
      // bounded by the room capacity while gen keeps increasing on every re-issue.
      const free = this.db.raw
        .prepare(
          `SELECT slot, gen, is_creator FROM slots WHERE room_id=? AND connected=0
           ORDER BY is_creator DESC, slot ASC LIMIT 1`
        )
        .get(input.roomId) as { slot: number; gen: number; is_creator: number } | undefined;

      let slot: number;
      let gen: number;
      let isCreator: boolean;
      if (free) {
        slot = free.slot;
        gen = free.gen + 1;
        isCreator = free.is_creator === 1;
        if (gen > 0xffff) return { code: ERR.storageFull } as const;
        this.db.raw
          .prepare('UPDATE slots SET gen=?, connected=1, last_seen=?, nick=?, nick_nonce=? WHERE room_id=? AND slot=?')
          .run(gen, now, input.nick, input.nickNonce, input.roomId, slot);
      } else {
        // Capacity is the count of live members (checked above); released slots are
        // always reused first, so slot ids stay bounded by the room's own cap.
        if (fresh.next_slot > MAX_SLOT) return { code: ERR.storageFull } as const;
        slot = fresh.next_slot;
        gen = 0;
        isCreator = false;
        this.db.raw
          .prepare(
            'INSERT INTO slots (room_id,slot,gen,is_creator,nick,nick_nonce,joined_at,last_seen,connected) VALUES (?,?,?,0,?,?,?,?,1)'
          )
          .run(input.roomId, slot, gen, input.nick, input.nickNonce, now, now);
        this.db.raw
          .prepare('UPDATE rooms SET next_slot=?, updated_at=?, empty_since=NULL WHERE id=?')
          .run(slot + 1, now, input.roomId);
      }

      const token = crypto.randomBytes(32).toString('base64url');
      this.db.raw
        .prepare('INSERT INTO session_tokens (token,room_id,slot,gen,created_at,expires_at) VALUES (?,?,?,?,?,?)')
        .run(token, input.roomId, slot, gen, now, now + 12 * 3600 * 1000);
      return { slot, gen, isCreator, sessionToken: token, headSeq: fresh.head_seq } as const;
    });

    if ('code' in result && result.code) return { ok: false, code: result.code };

    const slot = result.slot as number;
    mem.connected.set(slot, { gen: result.gen as number, lastSeen: now });
    if (mem.connected.size > 0) this.cancelEmptyTimer(input.roomId, mem);
    logger.info('member joined', { online: mem.connected.size });
    this.emit('members', input.roomId);
    return {
      ok: true,
      slot,
      gen: result.gen,
      isCreator: result.isCreator,
      sessionToken: result.sessionToken,
      headSeq: result.headSeq,
      oldestSeq: this.oldestSeq(input.roomId),
      members: this.members(input.roomId)
    };
  }

  /** Ends one member session. Returns how many session tokens it revoked, so destroy
   *  can report the full cleanup even though disconnects happen before the row sweep.
   *  `gen` is the generation the leaving connection actually held: slot numbers are
   *  re-issued, so a late event must never end the session that owns the slot now. */
  leave(roomId: string, slot: number, gen?: number): number {
    const mem = this.memOf(roomId);
    const session = mem.connected.get(slot);
    if (gen !== undefined && session && session.gen !== gen) return 0;
    if (session) {
      mem.connected.delete(slot);
      mem.buckets.delete(slot);
    }
    // Without a generation the caller means "this slot is finished" (destroy, and any
    // pre-existing caller); with one, only that generation's row and tokens are ended.
    this.db.raw
      .prepare('UPDATE slots SET connected=0 WHERE room_id=? AND slot=? AND (? IS NULL OR gen=?)')
      .run(roomId, slot, gen ?? null, gen ?? null);
    const revoked = this.db.raw
      .prepare('DELETE FROM session_tokens WHERE room_id=? AND slot=? AND (? IS NULL OR gen=?)')
      .run(roomId, slot, gen ?? null, gen ?? null).changes;
    if (mem.connected.size === 0) this.enterIdleGrace(roomId, Date.now());
    this.emit('members', roomId);
    return revoked;
  }

  /**
   * ACTIVE -> IDLE_GRACE: the last participant is gone but nothing is deleted yet. The room
   * keeps its ciphertext, its attachments and its slot against MAX_ROOMS for the full recovery
   * window, so a refresh, a device switch or a dropped network can walk back into the same room.
   */
  private enterIdleGrace(roomId: string, now: number): void {
    const changed = this.db.raw
      .prepare("UPDATE rooms SET status='IDLE_GRACE', empty_since=?, updated_at=? WHERE id=? AND status='ACTIVE'")
      .run(now, now, roomId).changes;
    if (changed) {
      // Only the first transition is worth a line; the sweep retries this every tick otherwise.
      // The number printed has to be the window *this* room is held for: writing the node default
      // next to a 72-hour arming would leave a reading in the operator's log that never happened.
      const held = this.db.raw.prepare('SELECT idle_delay_ms FROM rooms WHERE id=?').get(roomId) as { idle_delay_ms: number | null };
      logger.info('room entered idle grace', { windowMs: this.effectiveIdleTtlMs(held) });
    }
  }

  /** Returns whether the ping belonged to the session that owns the slot; an evicted
   *  connection must not keep a re-issued slot marked alive. */
  heartbeat(roomId: string, slot: number, gen?: number, now = Date.now()): boolean {
    const mem = this.memOf(roomId);
    const entry = mem.connected.get(slot);
    if (!entry || (gen !== undefined && entry.gen !== gen)) return false;
    entry.lastSeen = now;
    this.db.raw.prepare('UPDATE slots SET last_seen=? WHERE room_id=? AND slot=?').run(now, roomId, slot);
    return true;
  }

  members(roomId: string): MemberDto[] {
    const mem = this.memOf(roomId);
    const rows = this.db.raw
      .prepare('SELECT slot,gen,nick,nick_nonce,is_creator,joined_at,connected FROM slots WHERE room_id=? ORDER BY slot')
      .all(roomId) as {
      slot: number;
      gen: number;
      nick: Uint8Array | null;
      nick_nonce: Uint8Array | null;
      is_creator: number;
      joined_at: number;
      connected: number;
    }[];
    return rows.map((r) => ({
      slot: r.slot,
      gen: r.gen,
      nick: r.nick ? Buffer.from(r.nick).toString('base64') : null,
      nickNonce: r.nick_nonce ? Buffer.from(r.nick_nonce).toString('base64') : null,
      online: mem.connected.has(r.slot),
      isCreator: r.is_creator === 1,
      joinedAt: r.joined_at
    }));
  }

  setNick(roomId: string, slot: number, nick: Uint8Array, nickNonce: Uint8Array): void {
    this.db.raw
      .prepare('UPDATE slots SET nick=?, nick_nonce=? WHERE room_id=? AND slot=?')
      .run(nick, nickNonce, roomId, slot);
    this.emit('members', roomId);
  }

  // -------------------------------------------------------------- messages

  private consumeBucket(roomId: string, slot: number, now: number): boolean {
    const mem = this.memOf(roomId);
    let b = mem.buckets.get(slot);
    if (!b) {
      b = { tokens: LIMITS.msgBurst, refreshedAt: now };
      mem.buckets.set(slot, b);
    }
    b.tokens = Math.min(LIMITS.msgBurst, b.tokens + (now - b.refreshedAt) * TOKEN_REFILL_PER_MS);
    b.refreshedAt = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  appendMessage(input: AppendInput): AppendResult {
    const now = Date.now();
    const mem = this.memOf(input.roomId);
    const session = mem.connected.get(input.slot);
    if (!session || session.gen !== input.gen) {
      return { ok: false, code: ERR.notMember, clientMsgId: input.clientMsgId };
    }
    if (input.ct.length > LIMITS.textCiphertextBytes || input.nonce.length !== 12) {
      return { ok: false, code: ERR.tooLarge, clientMsgId: input.clientMsgId };
    }
    if (!this.consumeBucket(input.roomId, input.slot, now)) {
      return { ok: false, code: ERR.rateLimited, clientMsgId: input.clientMsgId };
    }
    const res = this.db.tx((): AppendResult => {
      const room = this.q.getRoom(input.roomId);
      if (!room) return { ok: false, code: ERR.roomNotFound, clientMsgId: input.clientMsgId };
      if (room.status !== 'ACTIVE') return { ok: false, code: ERR.roomDestroyed, clientMsgId: input.clientMsgId };
      const existing = this.db.raw
        .prepare('SELECT seq FROM messages WHERE room_id=? AND client_msg_id=?')
        .get(input.roomId, input.clientMsgId) as { seq: number } | undefined;
      if (existing) {
        return { ok: true, seq: existing.seq, dup: true, clientMsgId: input.clientMsgId, at: now };
      }
      if (room.head_seq >= LIMITS.messagesPerRoomHard) {
        return { ok: false, code: ERR.storageFull, clientMsgId: input.clientMsgId };
      }
      const seq = room.head_seq + 1;
      this.db.raw
        .prepare(
          'INSERT INTO messages (room_id,seq,client_msg_id,sender_slot,nonce,ct,kind,attachment_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
        )
        .run(input.roomId, seq, input.clientMsgId, input.slot, input.nonce, input.ct, input.kind, input.attachmentId ?? null, now);
      this.db.raw.prepare('UPDATE rooms SET head_seq=?, updated_at=? WHERE id=?').run(seq, now, input.roomId);
      return { ok: true, seq, dup: false, at: now, clientMsgId: input.clientMsgId };
    });
    if (res.ok && !res.dup) {
      this.emit('message', input.roomId, this.messageDto(input.roomId, res.seq as number));
    }
    return res;
  }

  messageDto(roomId: string, seq: number): MessageDto | null {
    const r = this.db.raw
      .prepare('SELECT * FROM messages WHERE room_id=? AND seq=?')
      .get(roomId, seq) as
      | { seq: number; client_msg_id: string; sender_slot: number; nonce: Uint8Array; ct: Uint8Array; kind: string; attachment_id: string | null; created_at: number }
      | undefined;
    if (!r) return null;
    return {
      seq: r.seq,
      clientMsgId: r.client_msg_id,
      senderSlot: r.sender_slot,
      nonce: Buffer.from(r.nonce).toString('base64'),
      ct: Buffer.from(r.ct).toString('base64'),
      kind: r.kind as MessageDto['kind'],
      attachmentId: r.attachment_id,
      at: r.created_at
    };
  }

  headSeq(roomId: string): number {
    const r = this.q.getRoom(roomId);
    return r ? r.head_seq : 0;
  }

  oldestSeq(roomId: string): number {
    const r = this.db.raw.prepare('SELECT MIN(seq) AS m FROM messages WHERE room_id=?').get(roomId) as { m: number | null };
    return r.m ?? 0;
  }

  history(roomId: string, opts: { beforeSeq?: number; limit?: number } = {}): { msgs: MessageDto[]; hasMore: boolean; oldestSeq: number } {
    const limit = Math.max(1, Math.min(opts.limit ?? LIMITS.historyPageSize, LIMITS.historyPageSize));
    const before = opts.beforeSeq ?? this.headSeq(roomId) + 1;
    const rows = this.db.raw
      .prepare('SELECT seq FROM messages WHERE room_id=? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(roomId, before, limit) as { seq: number }[];
    const msgs = rows
      .reverse()
      .map((r) => this.messageDto(roomId, r.seq))
      .filter((m): m is MessageDto => m !== null);
    const minSeq = this.oldestSeq(roomId);
    const first = rows.length ? (rows[rows.length - 1] as { seq: number }).seq : 0;
    return { msgs, hasMore: msgs.length === limit && first > minSeq, oldestSeq: minSeq };
  }

  since(roomId: string, sinceSeq: number, limit = LIMITS.syncGapMax): { msgs: MessageDto[]; gap: boolean } {
    const oldest = this.oldestSeq(roomId);
    if (oldest > 0 && sinceSeq < oldest - 1) return { msgs: [], gap: true };
    const rows = this.db.raw
      .prepare('SELECT seq FROM messages WHERE room_id=? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(roomId, sinceSeq, limit) as { seq: number }[];
    return {
      msgs: rows
        .map((r) => this.messageDto(roomId, r.seq))
        .filter((m): m is MessageDto => m !== null),
      gap: false
    };
  }

  // ------------------------------------------------------------ attachments

  createAttachment(p: {
    roomId: string;
    slot: number;
    gen: number;
    attachmentId: string;
    chunkSize: number;
    chunkCount: number;
    totalBytes: number;
    meta: Uint8Array;
    metaNonce: Uint8Array;
    kind: 'file' | 'image';
  }): { ok: boolean; code?: string } {
    const now = Date.now();
    if (p.chunkSize <= 0 || p.chunkSize > this.cfg.chunkBytesMax) return { ok: false, code: ERR.tooLarge };
    if (p.chunkCount <= 0 || p.chunkCount > 100_000) return { ok: false, code: ERR.tooLarge };
    if (p.totalBytes > this.cfg.attachmentBytesMax) return { ok: false, code: ERR.tooLarge };
    if (p.totalBytes > p.chunkSize * p.chunkCount) return { ok: false, code: ERR.tooLarge };
    const session = this.memOf(p.roomId).connected.get(p.slot);
    if (!session || session.gen !== p.gen) return { ok: false, code: ERR.notMember };
    return this.db.tx(() => {
      const room = this.q.getRoom(p.roomId);
      if (!room) return { ok: false, code: ERR.roomNotFound };
      if (room.status !== 'ACTIVE') return { ok: false, code: ERR.roomDestroyed };
      if (room.attachment_bytes + p.totalBytes > this.cfg.roomAttachmentBytesMax) return { ok: false, code: ERR.storageFull };
      // The node has a quota too: MAX_ROOMS rooms each at their own ceiling must not be able
      // to fill the disk of the machine that hosts them.
      const nodeBytes = (
        this.db.raw
          .prepare('SELECT COALESCE(SUM(attachment_bytes),0) c FROM rooms')
          .get() as { c: number }
      ).c;
      if (nodeBytes + p.totalBytes > this.cfg.tempBytesMaxNode) return { ok: false, code: ERR.storageFull };
      // One member hoarding reservations would otherwise hold the room's allowance open while
      // its chunks never arrive; the TTL releases them, but the door is closed first.
      const inFlight = (
        this.db.raw
          .prepare("SELECT COUNT(*) c FROM attachments WHERE room_id=? AND creator_slot=? AND state IN ('PENDING','UPLOADING')")
          .get(p.roomId, p.slot) as { c: number }
      ).c;
      if (inFlight >= LIMITS.pendingUploadsPerMember) return { ok: false, code: ERR.rateLimited };
      const dup = this.db.raw.prepare('SELECT id FROM attachments WHERE id=?').get(p.attachmentId) as { id: string } | undefined;
      if (dup) return { ok: true };
      this.db.raw
        .prepare(
          `INSERT INTO attachments (id,room_id,kind,chunk_size,chunk_count,total_bytes,meta,meta_nonce,created_at,expires_at,creator_slot,state)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING')`
        )
        .run(
          p.attachmentId,
          p.roomId,
          p.kind,
          p.chunkSize,
          p.chunkCount,
          p.totalBytes,
          p.meta,
          p.metaNonce,
          now,
          now + this.cfg.pendingUploadTtlMs,
          p.slot
        );
      this.db.raw
        .prepare('UPDATE rooms SET attachment_bytes=attachment_bytes+?, updated_at=? WHERE id=?')
        .run(p.totalBytes, now, p.roomId);
      return { ok: true };
    });
  }

  /**
   * The chunk bytes are already authenticated ciphertext frames. The room state is
   * re-checked after the disk write so an upload in flight cannot land in a room
   * that has started being destroyed.
   */
  async writeChunk(roomId: string, attachmentId: string, index: number, frame: Uint8Array, token: string): Promise<{ ok: boolean; code?: string; bytes?: number }> {
    const auth = this.authorizeToken(token, roomId);
    if (!auth) return { ok: false, code: ERR.authFailed };
    const att = this.db.raw
      .prepare('SELECT * FROM attachments WHERE id=? AND room_id=?')
      .get(attachmentId, roomId) as import('./db').AttachmentRow | undefined;
    if (!att) return { ok: false, code: ERR.attachmentNotFound };
    if (att.state !== 'PENDING' && att.state !== 'UPLOADING') return { ok: false, code: ERR.badState };
    if (index < 0 || index >= att.chunk_count) return { ok: false, code: ERR.tooLarge };
    if (frame.length > att.chunk_size + 64) return { ok: false, code: ERR.tooLarge };
    if (this.q.getRoom(roomId)?.status !== 'ACTIVE') return { ok: false, code: ERR.roomDestroyed };

    await this.storage.writeChunk(roomId, attachmentId, index, frame);

    const after = this.q.getRoom(roomId);
    if (!after || after.status !== 'ACTIVE') {
      await this.storage.removeAttachment(roomId, attachmentId);
      return { ok: false, code: ERR.roomDestroyed };
    }
    const now = Date.now();
    this.db.tx(() => {
      const prev = this.db.raw
        .prepare('SELECT bytes FROM attachment_chunks WHERE attachment_id=? AND idx=?')
        .get(attachmentId, index) as { bytes: number } | undefined;
      this.db.raw
        .prepare('INSERT INTO attachment_chunks (attachment_id,idx,bytes,received_at) VALUES (?,?,?,?) ON CONFLICT(attachment_id,idx) DO UPDATE SET bytes=excluded.bytes, received_at=excluded.received_at')
        .run(attachmentId, index, frame.length, now);
      const delta = frame.length - (prev?.bytes ?? 0);
      this.db.raw
        .prepare('UPDATE attachments SET uploaded_chunks=(SELECT COUNT(*) FROM attachment_chunks WHERE attachment_id=?), uploaded_bytes=uploaded_bytes+?, state=?, expires_at=? WHERE id=?')
        .run(attachmentId, delta, 'UPLOADING', now + this.cfg.pendingUploadTtlMs, attachmentId);
    });
    return { ok: true, bytes: frame.length };
  }

  completeAttachment(roomId: string, attachmentId: string, token: string): { ok: boolean; code?: string; chunkCount?: number } {
    const auth = this.authorizeToken(token, roomId);
    if (!auth) return { ok: false, code: ERR.authFailed };
    return this.db.tx(() => {
      const room = this.q.getRoom(roomId);
      if (!room || room.status !== 'ACTIVE') return { ok: false, code: ERR.roomDestroyed };
      const att = this.db.raw.prepare('SELECT * FROM attachments WHERE id=? AND room_id=?').get(attachmentId, roomId) as import('./db').AttachmentRow | undefined;
      if (!att) return { ok: false, code: ERR.attachmentNotFound };
      const count = (this.db.raw
        .prepare('SELECT COUNT(*) AS c FROM attachment_chunks WHERE attachment_id=?')
        .get(attachmentId) as { c: number }).c;
      if (count !== att.chunk_count) return { ok: false, code: ERR.badState, chunkCount: count };
      this.db.raw.prepare("UPDATE attachments SET state='READY', complete=1 WHERE id=?").run(attachmentId);
      this.emit('attachment', roomId, attachmentId);
      return { ok: true, chunkCount: count };
    });
  }

  abortAttachment(roomId: string, attachmentId: string, token: string): { ok: boolean } {
    const auth = this.authorizeToken(token, roomId);
    if (!auth) return { ok: false };
    this.db.tx(() => {
      const att = this.db.raw.prepare('SELECT total_bytes FROM attachments WHERE id=? AND room_id=?').get(attachmentId, roomId) as { total_bytes: number } | undefined;
      this.db.raw.prepare('DELETE FROM attachment_chunks WHERE attachment_id=?').run(attachmentId);
      this.db.raw.prepare('DELETE FROM attachments WHERE id=? AND room_id=?').run(attachmentId, roomId);
      if (att) {
        this.db.raw
          .prepare('UPDATE rooms SET attachment_bytes=MAX(0, attachment_bytes-?), updated_at=? WHERE id=?')
          .run(att.total_bytes, Date.now(), roomId);
      }
    });
    void this.storage.removeAttachment(roomId, attachmentId);
    return { ok: true };
  }

  attachmentIndex(roomId: string, attachmentId: string): AttachmentIndex | null {
    const att = this.db.raw.prepare('SELECT * FROM attachments WHERE id=? AND room_id=?').get(attachmentId, roomId) as import('./db').AttachmentRow | undefined;
    if (!att) return null;
    const idx = this.db.raw
      .prepare('SELECT idx FROM attachment_chunks WHERE attachment_id=? ORDER BY idx')
      .all(attachmentId) as { idx: number }[];
    return {
      attachmentId: att.id,
      roomId: att.room_id,
      chunkSize: att.chunk_size,
      chunkCount: att.chunk_count,
      totalBytes: att.total_bytes,
      meta: Buffer.from(att.meta).toString('base64'),
      metaNonce: Buffer.from(att.meta_nonce).toString('base64'),
      kind: att.kind as 'file' | 'image',
      uploadedChunks: idx.map((r) => r.idx),
      complete: att.complete === 1
    };
  }

  authorizeToken(token: string, roomId: string): { slot: number; gen: number } | null {
    const row = this.db.raw
      .prepare('SELECT slot, gen, expires_at FROM session_tokens WHERE token=? AND room_id=?')
      .get(token, roomId) as { slot: number; gen: number; expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) return null;
    const room = this.q.getRoom(roomId);
    if (!room || room.status !== 'ACTIVE') return null;
    if (!this.memOf(roomId).connected.has(row.slot)) return null;
    return { slot: row.slot, gen: row.gen };
  }

  // --------------------------------------------------------------- lifecycle

  /** Idempotent: concurrent callers converge on a single DESTROYING transition. */
  async destroy(
    roomId: string,
    reason: DestroyReason,
    creatorToken?: string
  ): Promise<{ ok: boolean; code?: string; report?: DestroyReport }> {
    const now = Date.now();
    const claim = this.db.tx(() => {
      const room = this.q.getRoom(roomId);
      if (!room) {
        // A replay of a destroy that already finished: the row is gone, and the bounded
        // in-memory report says so. Idempotent for the racing double-click without keeping a
        // permanent record of dead rooms.
        const prior = this.destroyReports.get(roomId);
        return prior
          ? { code: undefined as string | undefined, row: undefined, done: true }
          : { code: ERR.roomNotFound as string | undefined, row: undefined };
      }
      if (room.status === 'DESTROYED') return { code: undefined as string | undefined, row: undefined, done: true };
      if (room.status === 'DESTROYING') return { code: undefined as string | undefined, row: undefined, inFlight: true };
      if (reason === 'creator') {
        if (!creatorToken) return { code: ERR.notCreator, row: undefined };
        const given = Buffer.from(creatorToken, 'base64url');
        if (given.length !== room.creator_token.length || !crypto.timingSafeEqual(given, room.creator_token)) {
          return { code: ERR.notCreator, row: undefined };
        }
      }
      // Once this write lands, no new request, page refresh or process restart can put the
      // room back: joins are refused on DESTROYING and recovery only finishes the cleanup.
      this.q.setStatus(roomId, 'DESTROYING', now, reason);
      return { code: undefined as string | undefined, row: roomId as string | undefined };
    });

    if (claim.code) return { ok: false, code: claim.code };
    if (claim.done) {
      return { ok: true, report: this.destroyReports.get(roomId) };
    }
    if (claim.inFlight) {
      await this.waitForCleanup(roomId);
      // The row is the receipt: it is only deleted once the controlled storage proved empty,
      // so a caller waiting on someone else's cleanup gets told the truth about the outcome.
      if (this.q.getRoom(roomId)) return { ok: false, code: ERR.badState };
      return { ok: true, report: this.destroyReports.get(roomId) };
    }

    this.emit('destroying', roomId, reason);
    let revokedTokens = 0;
    for (const slot of [...this.memOf(roomId).connected.keys()]) {
      revokedTokens += this.leave(roomId, slot);
    }
    const report = await this.finishCleanup(roomId, reason, revokedTokens);
    logger.info('room destroyed', { reason, files: report.files, bytes: report.bytes, verified: report.verifiedEmpty });
    if (report.verifiedEmpty) this.emit('destroyed', roomId, reason);
    this.mem.delete(roomId);
    return { ok: true, report };
  }

  /**
   * Cleanup that either proves itself or keeps the room in DESTROYING: a directory Windows
   * still holds open is retried by the sweep instead of being reported as destroyed, and the
   * room keeps occupying one of the MAX_ROOMS slots until the last byte is gone.
   */
  private async finishCleanup(roomId: string, reason: string, tokensRevoked = 0): Promise<DestroyReport> {
    const report = await this.performCleanup(roomId, reason, tokensRevoked);
    if (!report.verifiedEmpty) {
      const prev = this.destroyRetries.get(roomId);
      this.destroyRetries.set(roomId, {
        reason,
        attempt: (prev?.attempt ?? 0) + 1,
        notBefore: Date.now() + this.cfg.destroyRetryMs
      });
      logger.warn('destroy cleanup incomplete, retry scheduled', { leftover: report.residualFiles, attempt: report.attempt });
      return report;
    }
    this.destroyRetries.delete(roomId);
    return report;
  }

  async performCleanup(roomId: string, reason: string, tokensRevoked = 0): Promise<DestroyReport> {
    const run = async (): Promise<DestroyReport> => {
      let removed = { files: 0, bytes: 0 };
      let failed = '';
      try {
        removed = await this.storage.removeRoom(roomId);
      } catch (err) {
        // A handle Windows has not released yet is a retry, not a destroyed claim. Only the
        // errno goes forward: the message would carry the room directory path, i.e. the room id.
        failed = (err as NodeJS.ErrnoException).code ?? 'storage-remove-failed';
      }
      const leftover = await this.storage.dirStat(this.storage.roomDir(roomId));
      if (leftover.files > 0 || failed) {
        // Rows stay behind on purpose: deleting them first would free the slot and forget the
        // room while its ciphertext is still on disk.
        return {
          roomId,
          reason,
          files: removed.files,
          bytes: removed.bytes,
          rows: emptyRowCounts(),
          verifiedEmpty: false,
          residualFiles: leftover.files,
          attempt: (this.destroyRetries.get(roomId)?.attempt ?? 0) + 1,
          status: 'DESTROYING'
        };
      }
      const rows = this.db.tx(() => {
        const counts = {
          messages: (this.db.raw.prepare('SELECT COUNT(*) c FROM messages WHERE room_id=?').get(roomId) as { c: number }).c,
          attachments: (this.db.raw.prepare('SELECT COUNT(*) c FROM attachments WHERE room_id=?').get(roomId) as { c: number }).c,
          chunks: (this.db.raw
            .prepare('SELECT COUNT(*) c FROM attachment_chunks c JOIN attachments a ON a.id=c.attachment_id WHERE a.room_id=?')
            .get(roomId) as { c: number }).c,
          slots: (this.db.raw.prepare('SELECT COUNT(*) c FROM slots WHERE room_id=?').get(roomId) as { c: number }).c,
          tokens: (this.db.raw.prepare('SELECT COUNT(*) c FROM session_tokens WHERE room_id=?').get(roomId) as { c: number }).c + tokensRevoked
        };
        this.db.raw.prepare('DELETE FROM session_tokens WHERE room_id=?').run(roomId);
        this.db.raw
          .prepare('DELETE FROM attachment_chunks WHERE attachment_id IN (SELECT id FROM attachments WHERE room_id=?)')
          .run(roomId);
        this.db.raw.prepare('DELETE FROM attachments WHERE room_id=?').run(roomId);
        this.db.raw.prepare('DELETE FROM messages WHERE room_id=?').run(roomId);
        this.db.raw.prepare('DELETE FROM slots WHERE room_id=?').run(roomId);
        // The room row itself goes too: no tombstone, no id-to-creator mapping, no record that
        // this room ever existed. A stale link now answers exactly like a never-used room id.
        this.db.raw.prepare('DELETE FROM rooms WHERE id=?').run(roomId);
        return counts;
      });
      this.db.checkpoint();
      this.db.vacuumIfFragmented(this.cfg.vacuumFreelistPages);
      const report: DestroyReport = {
        roomId,
        reason,
        files: removed.files,
        bytes: removed.bytes,
        rows,
        verifiedEmpty: true,
        residualFiles: 0,
        attempt: (this.destroyRetries.get(roomId)?.attempt ?? 0) + 1,
        status: 'DESTROYED'
      };
      this.rememberReport(roomId, report);
      return report;
    };
    const p = run().finally(() => this.cleanupInFlight.delete(roomId));
    this.cleanupInFlight.set(roomId, p);
    return p;
  }

  private cleanupInFlight = new Map<string, Promise<DestroyReport>>();

  private async waitForCleanup(roomId: string): Promise<void> {
    const inflight = this.cleanupInFlight.get(roomId);
    if (inflight) await inflight.catch(() => undefined);
  }

  // ---------------------------------------------------------- scheduled work

  start(now = Date.now()): void {
    this.sweepExpiredAttachments(now);
    const t1 = setInterval(() => this.tick(), Math.max(1000, Math.floor(this.cfg.heartbeatServerMs / 3)));
    const t2 = setInterval(() => this.sweepExpiredAttachments(), 60_000);
    t1.unref?.();
    t2.unref?.();
    this.timers.push(t1, t2);
  }

  /** One server tick: liveness, then the idle-grace countdown, then cleanup retries. */
  tick(now = Date.now()): { dropped: number; reclaimed: number; cancelled: number; destroyed: string[]; retried: number } {
    const heartbeats = this.sweepHeartbeats(now);
    const idle = this.sweepIdleGrace(now);
    const retried = this.retryPendingCleanups(now);
    return { ...heartbeats, ...idle, retried, destroyed: [...heartbeats.destroyed, ...idle.destroyed] };
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  sweepHeartbeats(now = Date.now()): { dropped: number; reclaimed: number; destroyed: string[] } {
    const destroyed: string[] = [];
    let dropped = 0;
    const cutoff = now - this.cfg.heartbeatGraceMs;
    for (const [roomId, mem] of [...this.mem]) {
      for (const [slot, s] of [...mem.connected]) {
        if (s.lastSeen < cutoff) {
          mem.connected.delete(slot);
          dropped++;
          this.db.raw.prepare('UPDATE slots SET connected=0 WHERE room_id=? AND slot=? AND gen=?').run(roomId, slot, s.gen);
          this.db.raw.prepare('DELETE FROM session_tokens WHERE room_id=? AND slot=? AND gen=?').run(roomId, slot, s.gen);
          this.emit('stale', roomId, slot, s.gen);
        }
      }
      if (mem.connected.size === 0) {
        this.enterIdleGrace(roomId, now);
      } else if (this.q.getRoom(roomId)?.empty_since) {
        this.cancelEmptyTimer(roomId, mem);
      }
    }
    // Slot rows are the capacity ledger while memory holds the sessions, so a row left
    // connected with no session behind it would refuse joins forever. The slot grace is
    // deliberately longer than the heartbeat grace, which reclaims live sessions first.
    let reclaimed = 0;
    const stranded = this.db.raw
      .prepare('SELECT room_id, slot, gen FROM slots WHERE connected=1 AND last_seen < ?')
      .all(now - this.cfg.slotGraceMs) as { room_id: string; slot: number; gen: number }[];
    for (const r of stranded) {
      if (this.memOf(r.room_id).connected.has(r.slot)) continue;
      this.db.raw
        .prepare('UPDATE slots SET connected=0 WHERE room_id=? AND slot=? AND gen=?')
        .run(r.room_id, r.slot, r.gen);
      this.db.raw.prepare('DELETE FROM session_tokens WHERE room_id=? AND slot=? AND gen=?').run(r.room_id, r.slot, r.gen);
      reclaimed++;
    }
    if (dropped) logger.info('heartbeat sweep dropped members', { dropped });
    if (reclaimed) logger.warn('stranded slot rows reclaimed', { reclaimed });
    return { dropped, reclaimed, destroyed };
  }

  /**
   * Creator authority, the same comparison `destroy` makes. The `is_creator` slot flag is not an
   * authority here because slot numbers are re-issued: whoever holds the 32 bytes in the row is the
   * owner, and that is the only definition that survives a reconnect.
   */
  private isCreatorToken(room: RoomRow, creatorToken: string): boolean {
    if (!creatorToken) return false;
    const given = Buffer.from(creatorToken, 'base64url');
    return given.length === room.creator_token.length && crypto.timingSafeEqual(given, room.creator_token);
  }

  /**
   * Arms (or clears) this room's own recovery window. Refused before anything is written when the
   * value is not one of the six shipped choices, so no arbitrary number can reach the sweep.
   */
  setIdleDelay(roomId: string, creatorToken: string, ms: number | null): { ok: boolean; code?: string } {
    if (ms !== null && !IDLE_DELAY_CHOICES_MS.includes(ms)) return { ok: false, code: ERR.badDelay };
    return this.db.tx(() => {
      const room = this.q.getRoom(roomId);
      if (!room || room.status === 'DESTROYING' || room.status === 'DESTROYED') return { ok: false, code: ERR.roomNotFound };
      if (!this.isCreatorToken(room, creatorToken)) return { ok: false, code: ERR.notCreator };
      if (ms === null) {
        // Always allowed, even with the feature switched off: an arming made before a config
        // tightening must stay revocable by the owner who made it.
        this.db.raw.prepare('UPDATE rooms SET idle_delay_ms=NULL, updated_at=? WHERE id=?').run(Date.now(), roomId);
        return { ok: true };
      }
      // The cap counts rooms currently holding a window, not arming operations: re-arming one that
      // already has it must not be refused by its owner's earlier choice.
      if (room.idle_delay_ms === null) {
        const armed = this.db.raw
          .prepare("SELECT COUNT(*) c FROM rooms WHERE idle_delay_ms IS NOT NULL AND status <> 'DESTROYING'")
          .get() as { c: number };
        if (armed.c >= this.cfg.maxDelayedRooms) return { ok: false, code: ERR.delayCapacityFull };
      }
      this.db.raw.prepare('UPDATE rooms SET idle_delay_ms=?, updated_at=? WHERE id=?').run(ms, Date.now(), roomId);
      return { ok: true };
    });
  }

  /** The owner's own read of what they armed. Members, and anyone probing without the token, get
   *  nothing: the public status route still answers one bit. */
  idleDelayFor(roomId: string, creatorToken: string): { ok: boolean; idleDelayMs?: number | null; code?: string } {
    const room = this.q.getRoom(roomId);
    if (!room) return { ok: false, code: ERR.roomNotFound };
    if (!this.isCreatorToken(room, creatorToken)) return { ok: false, code: ERR.notCreator };
    return { ok: true, idleDelayMs: room.idle_delay_ms };
  }

  private cancelEmptyTimer(roomId: string, mem: RoomMemory): void {
    if (mem.connected.size === 0) return;
    this.db.raw
      .prepare("UPDATE rooms SET status='ACTIVE', empty_since=NULL, idle_delay_ms=NULL, updated_at=? WHERE id=? AND status='IDLE_GRACE'")
      .run(Date.now(), roomId);
  }

  /**
   * The 300 s countdown, run off the same tick as the liveness sweep. `empty_since` is the
   * moment the room became idle and is written once, so neither a restart nor a repeated sweep
   * can stretch the window; the expiry transition into DESTROYING is the point of no return.
   */
  /**
   * The window a room is actually held for right now. Both places that decide expiry -- the sweep
   * and startup recovery -- have to ask this one question, because a restart that compared against
   * the node default would destroy every armed room the moment the process came back up, which is
   * exactly the reading no test on the sweep can see.
   */
  private effectiveIdleTtlMs(room: { idle_delay_ms: number | null }): number {
    return room.idle_delay_ms ?? this.cfg.roomIdleTtlMs;
  }

  sweepIdleGrace(now = Date.now()): { cancelled: number; destroyed: string[] } {
    const rows = this.db.raw
      .prepare("SELECT id, empty_since, idle_delay_ms FROM rooms WHERE status='IDLE_GRACE'")
      .all() as { id: string; empty_since: number | null; idle_delay_ms: number | null }[];
    const destroyed: string[] = [];
    let cancelled = 0;
    for (const r of rows) {
      const mem = this.memOf(r.id);
      if (mem.connected.size > 0) {
        // A member is back: the countdown is cancelled before it is ever measured.
        this.cancelEmptyTimer(r.id, mem);
        cancelled++;
        continue;
      }
      if (r.empty_since === null) {
        this.db.raw.prepare('UPDATE rooms SET empty_since=?, updated_at=? WHERE id=?').run(now, now, r.id);
        continue;
      }
      if (now - r.empty_since >= this.effectiveIdleTtlMs(r)) {
        void this.destroy(r.id, 'idle');
        destroyed.push(r.id);
      }
    }
    return { cancelled, destroyed };
  }

  private retryPendingCleanups(now = Date.now()): number {
    let retried = 0;
    for (const [roomId, job] of [...this.destroyRetries]) {
      if (now < job.notBefore) continue;
      retried++;
      void this.performCleanup(roomId, job.reason)
        .then((report) => {
          if (report.verifiedEmpty) {
            this.destroyRetries.delete(roomId);
            this.emit('destroyed', roomId, report.reason);
            logger.info('retry completed destroy', { reason: report.reason, attempt: report.attempt });
          } else {
            this.destroyRetries.set(roomId, { ...job, notBefore: Date.now() + this.cfg.destroyRetryMs });
          }
        })
        .catch((err: unknown) => {
          this.destroyRetries.set(roomId, { ...job, notBefore: Date.now() + this.cfg.destroyRetryMs });
          logger.error('destroy retry failed', { code: (err as NodeJS.ErrnoException).code ?? 'error' });
        });
    }
    return retried;
  }

  /** Rooms whose controlled cleanup has not finished yet; the admin commands must not lie. */
  pendingDestroys(): string[] {
    return [...this.destroyRetries.keys()];
  }

  /**
   * Run the owed cleanups now instead of waiting for the sweep, so an operator who unblocked the
   * disk (closed the handle, moved the share) can re-run the same command and have it finish.
   */
  async flushPendingDestroys(): Promise<{ finished: number; unfinished: number }> {
    let finished = 0;
    for (const [roomId, job] of [...this.destroyRetries]) {
      const report = await this.performCleanup(roomId, job.reason);
      if (report.verifiedEmpty) {
        this.destroyRetries.delete(roomId);
        this.mem.delete(roomId);
        finished++;
        this.emit('destroyed', roomId, report.reason);
      }
    }
    return { finished, unfinished: this.destroyRetries.size };
  }

  /** Drive every room the node holds into DESTROYING and wait for each cleanup to prove itself. */
  async destroyAllRooms(): Promise<{ rooms: number; unfinished: number }> {
    await this.flushPendingDestroys();
    const ids = this.db.raw
      .prepare(`SELECT id FROM rooms WHERE status IN (${SLOT_HOLDING_STATUSES.map(() => '?').join(',')})`)
      .all(...SLOT_HOLDING_STATUSES) as { id: string }[];
    let unfinished = 0;
    for (const r of ids) {
      const res = await this.destroy(r.id, 'admin');
      if (!res.report?.verifiedEmpty) unfinished++;
    }
    return { rooms: ids.length, unfinished };
  }

  /** Rows still tied to a room, whatever their state — used to prove a purge really emptied the DB. */
  rowCount(table: 'rooms' | 'slots' | 'messages' | 'attachments' | 'attachment_chunks' | 'session_tokens'): number {
    return (this.db.raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  }

  /**
   * The whole ephemeral database, emptied. Order matters: refuse new work first, let the
   * per-room path do its proven cleanup, then sweep whatever a crash could have left outside
   * a room (orphan directories, half-written .tmp chunks), and only then checkpoint + VACUUM so
   * the surviving file carries no pages of a room that used to be here.
   */
  async purgeAll(): Promise<{ rooms: number; rows: number; files: number; bytes: number; unfinished: number; residualFiles: number; ok: boolean }> {
    this.pause();
    const { rooms, unfinished } = await this.destroyAllRooms();
    const rows = this.db.tx(() => {
      let n = 0;
      for (const t of ['session_tokens', 'attachment_chunks', 'attachments', 'messages', 'slots', 'rooms'] as const) {
        n += this.db.raw.prepare(`DELETE FROM ${t}`).run().changes;
      }
      // The schema version row is runtime bookkeeping, not room data: it stays.
      return n;
    });
    let removed = { files: 0, bytes: 0 };
    let wipeFailed = '';
    try {
      removed = await this.storage.purgeAll();
    } catch (err) {
      wipeFailed = (err as NodeJS.ErrnoException).code ?? 'storage-purge-failed';
    }
    this.db.checkpoint();
    this.db.vacuum();
    this.mem.clear();
    // Retry entries are *not* dropped here: a room whose directory could not be wiped is still
    // owed a cleanup, and the sweep is what keeps trying. Clearing it would forget the debt.
    const residualRows =
      this.rowCount('rooms') +
      this.rowCount('slots') +
      this.rowCount('messages') +
      this.rowCount('attachments') +
      this.rowCount('attachment_chunks') +
      this.rowCount('session_tokens');
    const residualFiles = await this.storage.countAll();
    const ok = unfinished === 0 && residualRows === 0 && residualFiles === 0 && !wipeFailed;
    // A purge that cannot prove it emptied everything leaves the node in maintenance rather than
    // reporting a clean slate it did not deliver.
    if (ok) this.resume();
    logger.info('data purge completed', { rooms, rows, files: removed.files, ok });
    return { rooms, rows, files: removed.files, bytes: removed.bytes, unfinished, residualFiles, ok };
  }

  sweepExpiredAttachments(now = Date.now()): number {
    const rows = this.db.raw
      .prepare("SELECT id, room_id, total_bytes FROM attachments WHERE state IN ('PENDING','UPLOADING') AND expires_at < ?")
      .all(now) as { id: string; room_id: string; total_bytes: number }[];
    for (const r of rows) {
      this.db.tx(() => {
        this.db.raw.prepare('DELETE FROM attachment_chunks WHERE attachment_id=?').run(r.id);
        this.db.raw.prepare('DELETE FROM attachments WHERE id=?').run(r.id);
        // An expired reservation is only really reclaimed once its bytes go back to the
        // room quota, otherwise dead uploads permanently shrink the room's allowance.
        this.db.raw
          .prepare('UPDATE rooms SET attachment_bytes=MAX(0, attachment_bytes-?), updated_at=? WHERE id=?')
          .run(r.total_bytes, now, r.room_id);
      });
      void this.storage.removeAttachment(r.room_id, r.id);
    }
    if (rows.length) logger.info('expired pending uploads discarded', { count: rows.length });
    return rows.length;
  }

  // ------------------------------------------------------- restart recovery

  /**
   * No WebSocket survives a process restart, so every ACTIVE room loses its members and enters
   * the idle grace with the countdown it already has; a grace that expired while the process was
   * down is closed out now, and DESTROYING rooms are finished rather than revived. A destroyed
   * room has no row left to revive in the first place.
   */
  async recoverOnStartup(
    now = Date.now()
  ): Promise<{ active: string[]; finishing: string[]; markedEmpty: number; expired: string[] }> {
    const active = this.db.raw
      .prepare("SELECT id FROM rooms WHERE status='ACTIVE'")
      .all() as { id: string }[];
    const finishing = this.db.raw
      .prepare("SELECT id FROM rooms WHERE status='DESTROYING'")
      .all() as { id: string }[];
    this.db.raw.prepare('UPDATE slots SET connected=0').run();
    this.db.raw.prepare('DELETE FROM session_tokens').run();
    for (const r of active) this.enterIdleGrace(r.id, now);
    // A grace clocked before the restart keeps its own start time, so downtime counts against
    // the window rather than resetting it: the recovery window is a wall-clock promise, not an
    // uptime one -- and that holds equally for an owner-armed multi-hour window.
    const inGrace = this.db.raw
      .prepare("SELECT id, empty_since, idle_delay_ms FROM rooms WHERE status='IDLE_GRACE'")
      .all() as { id: string; empty_since: number | null; idle_delay_ms: number | null }[];
    const expired: string[] = [];
    for (const r of inGrace) {
      if (r.empty_since === null) {
        this.db.raw.prepare('UPDATE rooms SET empty_since=?, updated_at=? WHERE id=?').run(now, now, r.id);
      } else if (now - r.empty_since >= this.effectiveIdleTtlMs(r)) {
        expired.push(r.id);
      }
    }
    for (const r of finishing) {
      await this.performCleanup(r.id, 'shutdown');
      logger.info('unfinished destroy completed after restart');
    }
    for (const id of expired) await this.destroy(id, 'idle');
    const held = this.db.raw
      .prepare(`SELECT id FROM rooms WHERE status IN (${SLOT_HOLDING_STATUSES.map(() => '?').join(',')})`)
      .all(...SLOT_HOLDING_STATUSES) as { id: string }[];
    const orphans = await this.storage.pruneOrphanRooms(new Set(held.map((r) => r.id)));
    if (orphans.length) logger.info('orphan attachment directories pruned', { count: orphans.length });
    return { active: active.map((r) => r.id), finishing: finishing.map((r) => r.id), markedEmpty: active.length, expired };
  }

  /**
   * Aggregate runtime counters. These never leave the process: they are for the local admin
   * command's summary, not an HTTP field, because a public count of live rooms is a discovery
   * surface and an invitation to probe capacity.
   */
  stats(): {
    roomsActive: number;
    roomsIdleGrace: number;
    roomsDestroying: number;
    slotsHeld: number;
    maxRooms: number;
    messages: number;
    attachments: number;
    online: number;
    trackedRooms: number;
    tempBytes: number;
  } {
    const c = (sql: string, ...args: unknown[]) => (this.db.raw.prepare(sql).get(...args) as { c: number }).c;
    const count = (status: RoomStatus) => c('SELECT COUNT(*) c FROM rooms WHERE status=?', status);
    return {
      roomsActive: count('ACTIVE'),
      roomsIdleGrace: count('IDLE_GRACE'),
      roomsDestroying: count('DESTROYING'),
      slotsHeld: this.slotsHeld(),
      maxRooms: this.cfg.maxRooms,
      messages: c('SELECT COUNT(*) c FROM messages'),
      attachments: c('SELECT COUNT(*) c FROM attachments'),
      online: [...this.mem.values()].reduce((n, m) => n + m.connected.size, 0),
      trackedRooms: this.mem.size,
      tempBytes: c('SELECT COALESCE(SUM(attachment_bytes),0) c FROM rooms')
    };
  }
}

function hmacJoin(joinKey: Uint8Array | Buffer, roomId: string, challenge: Uint8Array): Buffer {
  return crypto
    .createHmac('sha256', joinKey)
    .update(`poofspace/v1/join|${roomId}|${Buffer.from(challenge).toString('hex')}`)
    .digest();
}
