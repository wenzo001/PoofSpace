import { LIMITS, ERR, PROTO_VERSION, TERMINAL_JOIN_CODES } from '../constants';
import {
  b64ToBytes,
  bytesToB64,
  bytesToB64url,
  concatBytes,
  hexToBytes,
  randomBytes,
  randomHex,
  utf8
} from '../encoding';
import { aeadDecrypt, aeadEncrypt, assertCryptoUsable, detectCrypto, hmacNonce, wipe, type CryptoCapability } from '../crypto/engine';
import { deriveRoomKeys, computeJoinProof, type RoomKeys } from '../crypto/keys';
import { decodeRoomId, encodeRoomId, newSecretBytes, buildInviteLink, makeInviteCode } from '../crypto/invite';
import { openChunk, openMessage, openMeta, sealChunk, sealMessage, sealMeta, type AttachmentMeta, type MessagePayload } from '../crypto/envelope';
import type { ClientFrame, MemberDto, MessageDto, ServerFrame } from '../proto';

export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type SocketFactory = (url: string) => WsLike;

export interface RoomClientOptions {
  base: string;
  openSocket: SocketFactory;
  fetchImpl?: typeof fetch;
  ackTimeoutMs?: number;
  maxMembers?: number;
}

export type SendState = 'sending' | 'sent' | 'failed';

export interface ClientMessage {
  clientMsgId: string;
  seq: number;
  slot: number;
  kind: 'text' | 'file' | 'image';
  text: string;
  attachmentId?: string;
  attachment?: AttachmentMeta;
  at: number;
  state: SendState;
  own: boolean;
  error?: string;
}

export interface InviteInfo {
  roomId: string;
  link: string;
  code: string;
}

export type ClientEvent =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'message'; msg: ClientMessage }
  | { type: 'message-state'; clientMsgId: string; state: SendState; error?: string }
  | { type: 'members'; members: (MemberDto & { nickPlain?: string | null })[] }
  | { type: 'destroying'; reason: string }
  | { type: 'destroyed'; reason: string }
  | { type: 'history-loaded'; count: number; hasMore: boolean }
  | { type: 'upload-progress'; attachmentId: string; sent: number; total: number }
  | { type: 'error'; code: string; message: string };

export class CryptoBlockedError extends Error {
  readonly code = ERR.cryptoUnavailable;
  constructor(message: string) {
    super(message);
    this.name = 'CryptoBlockedError';
  }
}

/**
 * Client-side room session. Owns the invite secret, every derived key, and the
 * nonce counter. The server only ever receives the room id, the joinKey digest,
 * opaque ciphertext blobs, and byte lengths.
 */
export class RoomClient {
  readonly capability: CryptoCapability;
  private keys: RoomKeys;
  private nickSalt: Uint8Array;
  private counter = 0;
  private slot = 0;
  private gen = 0;
  private ws: WsLike | null = null;
  private serverNonce: Uint8Array | null = null;
  private sessionToken = '';
  private listeners: ((e: ClientEvent) => void)[] = [];
  private pending = new Map<string, { frame: Extract<ClientFrame, { t: 'msg:send' }>; timer: ReturnType<typeof setTimeout> }>();
  private uploadWaiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  private byClientMsgId = new Map<string, ClientMessage>();
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 500;

  invite: InviteInfo;
  creatorToken = '';
  isCreator = false;
  members: (MemberDto & { nickPlain?: string | null })[] = [];
  headSeq = 0;
  oldestSeq = 0;
  chunkSizeMax = LIMITS.chunkBytesMax;
  status: 'new' | 'connecting' | 'open' | 'closed' | 'destroyed' = 'new';
  nick = '';

  private constructor(opts: RoomClientOptions, invite: InviteInfo, secret: Uint8Array) {
    this.capability = detectCrypto();
    assertCryptoUsable(this.capability);
    this.keys = deriveRoomKeys(secret);
    this.nickSalt = randomBytes(16);
    this.opts = opts;
    this.invite = invite;
    wipe(secret);
  }

  private readonly opts: RoomClientOptions;

  /** New room: the id and secret are minted here and never handed to the server. */
  static async createRoom(opts: RoomClientOptions, nick: string): Promise<RoomClient> {
    const secret = newSecretBytes();
    const roomId = encodeRoomId(randomBytes(16));
    const invite: InviteInfo = {
      roomId,
      link: buildInviteLink(opts.base, { roomId, secret }),
      code: makeInviteCode({ roomId, secret })
    };
    const client = new RoomClient(opts, invite, secret);
    client.nick = nick;
    const res = await client.http('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, joinKey: bytesToB64url(client.keys.joinKey), maxMembers: opts.maxMembers })
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(detail?.message ?? `room create failed: ${res.status}`);
    }
    const body = (await res.json()) as { creatorToken: string };
    client.creatorToken = body.creatorToken;
    client.isCreator = true;
    return client;
  }

  static fromSecret(opts: RoomClientOptions, input: { roomId: string; secret: Uint8Array }, nick: string): RoomClient {
    const roomId = encodeRoomId(decodeRoomId(input.roomId));
    const secret = input.secret.slice();
    const invite: InviteInfo = {
      roomId,
      link: buildInviteLink(opts.base, { roomId, secret }),
      code: makeInviteCode({ roomId, secret })
    };
    const client = new RoomClient(opts, invite, secret);
    client.nick = nick;
    return client;
  }

  get publicInvite(): { roomId: string; link: string; code: string } {
    return { roomId: this.invite.roomId, link: this.invite.link, code: this.invite.code };
  }

  on(cb: (e: ClientEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== cb);
    };
  }

  private emit(e: ClientEvent): void {
    for (const l of this.listeners) l(e);
  }

  private http(path: string, init: RequestInit = {}): Promise<Response> {
    const f = this.opts.fetchImpl ?? fetch;
    const headers = new Headers(init.headers ?? {});
    if (this.sessionToken) headers.set('authorization', `Bearer ${this.sessionToken}`);
    return f(this.opts.base + path, { ...init, headers, cache: 'no-store' });
  }

  // ------------------------------------------------------------ connection

  connect(): Promise<void> {
    this.closedByUser = false;
    this.status = 'connecting';
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = this.opts.openSocket(wsUrl(this.opts.base));
      this.ws = ws;
      ws.onopen = () => {
        this.status = 'open';
        this.backoffMs = 500;
        this.emit({ type: 'connected' });
      };
      ws.onmessage = (ev) => {
        const text = decodeFrameBytes(ev.data);
        let frame: ServerFrame;
        try {
          frame = JSON.parse(text) as ServerFrame;
        } catch {
          return;
        }
        this.handleFrame(frame);
        if (frame.t === 'hello') {
          void this.sendJoin().catch((err: Error) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
          return;
        }
        if (settled) return;
        if (frame.t === 'join:ok') {
          settled = true;
          resolve();
          return;
        }
        if (frame.t === 'join:err') {
          settled = true;
          reject(new Error(frame.code));
        }
      };
      ws.onclose = () => {
        if (this.status !== 'destroyed') this.status = 'closed';
        this.emit({ type: 'disconnected' });
        if (!settled) {
          settled = true;
          reject(new Error('socket closed before join completed'));
        }
        this.scheduleReconnect();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('socket error'));
        }
      };
    });
  }

  /**
   * Application-level heartbeat. The server only keeps a member alive while it sees
   * these frames, so a backgrounded tab that resumes keeps its slot and a dead one is
   * dropped by the grace sweep instead of holding the room open forever.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => this.sendFrame({ t: 'ping' }), LIMITS.heartbeatClientMs);
    this.pingTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Rejoin with the same secret; the server issues a new slot/gen pair. */
  private scheduleReconnect(): void {
    if (this.closedByUser || this.status === 'destroyed' || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect()
        .then(() => this.resync())
        .catch(() => this.scheduleReconnect());
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 8000);
    this.reconnectTimer.unref?.();
  }

  private async sendJoin(): Promise<void> {
    if (!this.serverNonce) throw new Error('no server nonce');
    const sealed = await this.sealNick(this.nick);
    const proof = computeJoinProof(this.keys.joinKey, this.invite.roomId, this.serverNonce);
    this.sendFrame({
      t: 'join',
      roomId: this.invite.roomId,
      proof: bytesToB64(proof),
      nick: sealed.nick,
      nickNonce: sealed.nickNonce
    });
  }

  setNickname(nick: string): void {
    this.nick = nick;
    if (this.status !== 'open') return;
    void this.sealNick(nick).then((s) => this.sendFrame({ t: 'nick:set', nick: s.nick, nickNonce: s.nickNonce }));
  }

  /**
   * Nicknames are room-private: sealed with the metadata key so the server relays an
   * opaque blob. The per-session salt keeps nonces distinct across sessions while a
   * repeat of the same nickname reuses only its own (nonce, plaintext, AAD) triple.
   */
  private async sealNick(nick: string): Promise<{ nick: string; nickNonce: string }> {
    const nonce = hmacNonce(this.keys.metaKey, `nick|${bytesToB64url(this.nickSalt)}|${nick}`);
    const ct = await aeadEncrypt(this.keys.metaKey, nonce, nickAAD(this.invite.roomId), utf8(nick));
    return { nick: bytesToB64(ct), nickNonce: bytesToB64(nonce) };
  }

  async openNick(m: MemberDto): Promise<string | null> {
    if (!m.nick || !m.nickNonce) return null;
    try {
      return new TextDecoder().decode(
        await aeadDecrypt(this.keys.metaKey, b64ToBytes(m.nickNonce), nickAAD(this.invite.roomId), b64ToBytes(m.nick))
      );
    } catch {
      return null;
    }
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.sendFrame({ t: 'leave' });
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.status = this.status === 'destroyed' ? 'destroyed' : 'closed';
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      this.markFailed(p.frame.clientMsgId, 'closed');
    }
    this.pending.clear();
  }

  private sendFrame(frame: ClientFrame): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(frame));
  }

  // ---------------------------------------------------------------- frames

  private handleFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case 'hello':
        this.serverNonce = b64ToBytes(frame.serverNonce);
        this.chunkSizeMax = frame.chunkSizeMax;
        return;
      case 'join:ok': {
        this.slot = frame.slot;
        this.gen = frame.gen;
        this.counter = 0;
        this.headSeq = frame.headSeq;
        this.oldestSeq = frame.oldestSeq;
        this.sessionToken = frame.sessionToken;
        this.startHeartbeat();
        this.isCreator = frame.isCreator || this.isCreator;
        void this.applyMembers(frame.members);
        return;
      }
      case 'members':
        void this.applyMembers(frame.members);
        return;
      case 'msg:new':
        void this.ingest(frame.msg);
        return;
      case 'msg:ack': {
        const p = this.pending.get(frame.clientMsgId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(frame.clientMsgId);
        }
        const m = this.byClientMsgId.get(frame.clientMsgId);
        if (m) {
          m.state = 'sent';
          m.seq = frame.seq;
          m.at = frame.at;
          this.headSeq = Math.max(this.headSeq, frame.seq);
          this.emit({ type: 'message-state', clientMsgId: m.clientMsgId, state: 'sent' });
        }
        return;
      }
      case 'msg:nack': {
        const p = this.pending.get(frame.clientMsgId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(frame.clientMsgId);
        }
        this.markFailed(frame.clientMsgId, frame.code);
        return;
      }
      case 'sync:ok':
        this.headSeq = frame.headSeq;
        for (const m of frame.msgs) void this.ingest(m);
        return;
      case 'sync:gap':
        this.oldestSeq = frame.oldestSeq;
        this.headSeq = frame.headSeq;
        void this.reloadHistory();
        return;
      case 'room:destroying':
        this.emit({ type: 'destroying', reason: frame.reason });
        return;
      case 'room:destroyed':
        this.status = 'destroyed';
        this.closedByUser = true;
        this.emit({ type: 'destroyed', reason: frame.reason });
        this.discardSecrets();
        return;
      case 'upload:ready': {
        const w = this.uploadWaiters.get(frame.attachmentId);
        if (w) {
          this.uploadWaiters.delete(frame.attachmentId);
          w.resolve();
        }
        return;
      }
      case 'upload:err': {
        const w = this.uploadWaiters.get(frame.attachmentId);
        if (w) {
          this.uploadWaiters.delete(frame.attachmentId);
          if (frame.code === 'ABORTED') w.resolve();
          else w.reject(new Error(`upload rejected: ${frame.code}`));
        }
        return;
      }
      case 'join:err':
        this.emit({ type: 'error', code: frame.code, message: `join refused: ${frame.code}` });
        // A refusal that will still be true on the next attempt ends the session: reconnecting
        // against a destroyed room is a loop that never succeeds and never stops.
        if (TERMINAL_JOIN_CODES.includes(frame.code)) {
          this.status = 'destroyed';
          this.emit({ type: 'destroyed', reason: frame.code });
        }
        return;
      case 'error':
        this.emit({ type: 'error', code: frame.code, message: frame.message });
        return;
      default:
        return;
    }
  }

  private discardSecrets(): void {
    this.byClientMsgId.clear();
    this.pending.clear();
    wipe(this.keys.msgKey);
    wipe(this.keys.fileKey);
    wipe(this.keys.metaKey);
    this.keys = { msgKey: new Uint8Array(32), fileKey: new Uint8Array(32), metaKey: new Uint8Array(32), joinKey: new Uint8Array(32) };
  }

  private async applyMembers(list: MemberDto[]): Promise<void> {
    const withNicks = await Promise.all(
      list.map(async (m) => ({ ...m, nickPlain: (await this.openNick(m)) ?? undefined }))
    );
    this.members = withNicks;
    this.emit({ type: 'members', members: withNicks });
  }

  private markFailed(clientMsgId: string, code: string): void {
    const m = this.byClientMsgId.get(clientMsgId);
    if (!m) return;
    m.state = 'failed';
    m.error = code;
    this.emit({ type: 'message-state', clientMsgId, state: 'failed', error: code });
  }

  private async ingest(dto: MessageDto): Promise<void> {
    const existing = this.byClientMsgId.get(dto.clientMsgId);
    if (existing) {
      if (existing.seq !== dto.seq) {
        existing.seq = dto.seq;
        existing.at = dto.at;
        existing.state = 'sent';
        this.emit({ type: 'message', msg: existing });
      }
      this.headSeq = Math.max(this.headSeq, dto.seq);
      return;
    }
    let payload: MessagePayload;
    try {
      payload = await openMessage(this.keys.msgKey, this.invite.roomId, dto.clientMsgId, { nonce: dto.nonce, ct: dto.ct });
    } catch {
      // Never render what failed authentication, and never hide that it happened.
      this.emit({ type: 'error', code: ERR.decryptFailed, message: `message ${dto.seq} failed authentication` });
      return;
    }
    const msg: ClientMessage = {
      clientMsgId: dto.clientMsgId,
      seq: dto.seq,
      slot: dto.senderSlot,
      kind: dto.kind === 'system' ? 'text' : dto.kind,
      text: payload.kind === 'text' ? payload.body : '',
      attachmentId: payload.kind === 'text' ? undefined : payload.attachmentId,
      at: dto.at,
      state: 'sent',
      own: dto.senderSlot === this.slot
    };
    this.byClientMsgId.set(msg.clientMsgId, msg);
    this.headSeq = Math.max(this.headSeq, dto.seq);
    this.emit({ type: 'message', msg });
  }

  /** Stable order: server sequence first, unacked sends last by send time. */
  list(): ClientMessage[] {
    return [...this.byClientMsgId.values()].sort((a, b) => {
      const sa = a.seq > 0 ? a.seq : Number.MAX_SAFE_INTEGER;
      const sb = b.seq > 0 ? b.seq : Number.MAX_SAFE_INTEGER;
      return sa !== sb ? sa - sb : a.at - b.at;
    });
  }

  // --------------------------------------------------------------- sending

  /**
   * The envelope is generated once per clientMsgId and cached, so a retry replays
   * identical bytes instead of pairing a new nonce with a possibly-new plaintext.
   */
  async sendText(body: string): Promise<ClientMessage> {
    if (this.status !== 'open') throw new Error('not connected');
    if (!this.capability.csprng) throw new CryptoBlockedError('CSPRNG unavailable, refusing to send');
    const clientMsgId = randomHex(16);
    const sealed = await sealMessage(
      this.keys.msgKey,
      { slot: this.slot, gen: this.gen },
      ++this.counter,
      this.invite.roomId,
      clientMsgId,
      { kind: 'text', body }
    );
    const frame: Extract<ClientFrame, { t: 'msg:send' }> = {
      t: 'msg:send',
      reqId: clientMsgId,
      clientMsgId,
      kind: 'text',
      nonce: bytesToB64(sealed.nonce),
      ct: bytesToB64(sealed.ct)
    };
    return this.dispatch(frame, body);
  }

  private dispatch(frame: Extract<ClientFrame, { t: 'msg:send' }>, body: string): ClientMessage {
    const msg: ClientMessage = {
      clientMsgId: frame.clientMsgId,
      seq: 0,
      slot: this.slot,
      kind: frame.kind,
      text: body,
      attachmentId: frame.attachmentId,
      at: Date.now(),
      state: 'sending',
      own: true
    };
    this.byClientMsgId.set(msg.clientMsgId, msg);
    this.emit({ type: 'message', msg });
    const timer = setTimeout(() => {
      this.pending.delete(msg.clientMsgId);
      this.markFailed(msg.clientMsgId, 'TIMEOUT');
    }, this.opts.ackTimeoutMs ?? 15_000);
    timer.unref?.();
    this.pending.set(msg.clientMsgId, { frame, timer });
    this.sendFrame(frame);
    return msg;
  }

  async retry(clientMsgId: string): Promise<boolean> {
    const p = this.pending.get(clientMsgId);
    const msg = this.byClientMsgId.get(clientMsgId);
    const frame = p?.frame ?? this.cachedFrame(clientMsgId, msg);
    if (!frame || !msg) return false;
    msg.state = 'sending';
    msg.error = undefined;
    this.emit({ type: 'message-state', clientMsgId, state: 'sending' });
    const timer = setTimeout(() => {
      this.pending.delete(clientMsgId);
      this.markFailed(clientMsgId, 'TIMEOUT');
    }, this.opts.ackTimeoutMs ?? 15_000);
    timer.unref?.();
    this.pending.set(clientMsgId, { frame, timer });
    this.sendFrame(frame);
    return true;
  }

  /** After a disconnect the pending frame is gone from the map; rebuild it from the
   *  cached envelope only when the original bytes are still available. */
  private cachedFrame(clientMsgId: string, msg: ClientMessage | undefined): Extract<ClientFrame, { t: 'msg:send' }> | null {
    if (!msg || msg.state === 'sent') return null;
    return null;
  }

  // --------------------------------------------------------------- history

  async loadOlder(): Promise<{ count: number; hasMore: boolean }> {
    const before = this.oldestLoaded();
    const res = await this.http(`/api/rooms/${this.invite.roomId}/messages?beforeSeq=${before}&limit=${LIMITS.historyPageSize}`);
    if (!res.ok) throw new Error(`history failed: ${res.status}`);
    const page = (await res.json()) as { msgs: MessageDto[]; hasMore: boolean; oldestSeq: number };
    this.oldestSeq = page.oldestSeq;
    for (const dto of page.msgs) await this.ingest(dto);
    this.emit({ type: 'history-loaded', count: page.msgs.length, hasMore: page.hasMore });
    return { count: page.msgs.length, hasMore: page.hasMore };
  }

  private oldestLoaded(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const m of this.byClientMsgId.values()) if (m.seq > 0) min = Math.min(min, m.seq);
    return Number.isFinite(min) ? min : this.headSeq + 1;
  }

  /** Walks back page by page until the retained window is exhausted. */
  async reloadHistory(): Promise<number> {
    let total = 0;
    for (let guard = 0; guard < LIMITS.historyPageMax; guard++) {
      const page = await this.loadOlder();
      total += page.count;
      if (!page.hasMore || page.count === 0) break;
    }
    return total;
  }

  async resync(): Promise<void> {
    const minSeq = this.oldestLoadedSafe();
    if (this.oldestSeq > 0 && minSeq < this.oldestSeq) {
      await this.reloadHistory();
      return;
    }
    this.sendFrame({ t: 'sync', sinceSeq: minSeq });
  }

  private oldestLoadedSafe(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const m of this.byClientMsgId.values()) if (m.seq > 0) min = Math.min(min, m.seq);
    return Number.isFinite(min) ? min : 0;
  }

  // ----------------------------------------------------------- attachments

  async upload(opts: {
    name: string;
    mime: string;
    size: number;
    kind: 'file' | 'image';
    slice: (start: number, length: number) => Promise<Uint8Array>;
    width?: number;
    height?: number;
    concurrency?: number;
    chunkSize?: number;
  }): Promise<{ attachmentId: string; meta: AttachmentMeta; msg: ClientMessage }> {
    if (this.status !== 'open') throw new Error('not connected');
    const chunkSize = Math.min(opts.chunkSize ?? LIMITS.chunkBytes, this.chunkSizeMax);
    const chunkCount = Math.max(1, Math.ceil(opts.size / chunkSize));
    const attachmentId = randomHex(16);
    const meta: AttachmentMeta = {
      name: opts.name,
      mime: opts.mime,
      size: opts.size,
      chunkSize,
      chunkCount,
      kind: opts.kind,
      width: opts.width,
      height: opts.height
    };
    const sealedMeta = await sealMeta(this.keys.metaKey, this.invite.roomId, attachmentId, meta);
    await this.reserveUpload(attachmentId, meta, sealedMeta);

    const limit = Math.max(1, Math.min(opts.concurrency ?? 3, LIMITS.uploadConcurrencyMax));
    let next = 0;
    let sentCount = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < limit; i++) {
      workers.push(
        (async () => {
          for (;;) {
            const index = next++;
            if (index >= chunkCount) return;
            const start = index * chunkSize;
            const length = Math.max(0, Math.min(chunkSize, opts.size - start));
            const plain = await opts.slice(start, length);
            const frame = await sealChunk(
              this.keys.fileKey,
              { slot: this.slot, gen: this.gen },
              index + 1,
              this.invite.roomId,
              attachmentId,
              index,
              plain
            );
            wipe(plain);
            const res = await this.http(
              `/api/rooms/${this.invite.roomId}/uploads/${attachmentId}/chunks/${index}`,
              { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: frame as unknown as BodyInit }
            );
            if (!res.ok) {
              const detail = (await res.text()).slice(0, 160);
              throw new Error(`chunk ${index} rejected (${res.status}): ${detail}`);
            }
            sentCount++;
            this.emit({ type: 'upload-progress', attachmentId, sent: sentCount, total: chunkCount });
          }
        })()
      );
    }
    const done = await Promise.allSettled(workers);
    const failed = done.find((d) => d.status === 'rejected');
    if (failed) {
      await this.abortUpload(attachmentId);
      throw (failed as PromiseRejectedResult).reason as Error;
    }
    const complete = await this.http(`/api/rooms/${this.invite.roomId}/uploads/${attachmentId}/complete`, { method: 'POST' });
    if (!complete.ok) {
      await this.abortUpload(attachmentId);
      throw new Error(`upload complete failed: ${complete.status}`);
    }
    const clientMsgId = randomHex(16);
    const sealed = await sealMessage(
      this.keys.msgKey,
      { slot: this.slot, gen: this.gen },
      ++this.counter,
      this.invite.roomId,
      clientMsgId,
      { kind: opts.kind, attachmentId }
    );
    const msg = this.dispatch(
      {
        t: 'msg:send',
        reqId: clientMsgId,
        clientMsgId,
        kind: opts.kind,
        nonce: bytesToB64(sealed.nonce),
        ct: bytesToB64(sealed.ct),
        attachmentId
      },
      opts.name
    );
    msg.attachment = meta;
    return { attachmentId, meta, msg };
  }

  private async reserveUpload(
    attachmentId: string,
    meta: AttachmentMeta,
    sealedMeta: { nonce: Uint8Array; ct: Uint8Array }
  ): Promise<void> {
    const slot = this.uploadWaiters.get(attachmentId);
    if (slot) return;
    await new Promise<void>((resolve, reject) => {
      this.uploadWaiters.set(attachmentId, { resolve, reject });
      this.sendFrame({
        t: 'upload:create',
        attachmentId,
        chunkSize: meta.chunkSize,
        chunkCount: meta.chunkCount,
        totalBytes: meta.size,
        meta: bytesToB64(sealedMeta.ct),
        metaNonce: bytesToB64(sealedMeta.nonce),
        kind: meta.kind
      });
      const timer = setTimeout(() => {
        this.uploadWaiters.delete(attachmentId);
        reject(new Error('upload reservation timed out'));
      }, 10_000);
      timer.unref?.();
    });
  }

  private async abortUpload(attachmentId: string): Promise<void> {
    this.sendFrame({ t: 'upload:abort', attachmentId });
    try {
      await this.http(`/api/rooms/${this.invite.roomId}/uploads/${attachmentId}`, { method: 'DELETE' });
    } catch {
      /* best effort */
    }
  }

  async download(attachmentId: string): Promise<Uint8Array> {
    const meta = await this.readMeta(attachmentId);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < meta.chunkCount; i++) {
      const r = await this.http(`/api/rooms/${this.invite.roomId}/attachments/${attachmentId}/chunks/${i}`);
      if (!r.ok) throw new Error(`chunk ${i} unavailable: ${r.status}`);
      const frame = new Uint8Array(await r.arrayBuffer());
      parts.push(await openChunk(this.keys.fileKey, this.invite.roomId, attachmentId, i, frame));
    }
    return concatBytes(...parts);
  }

  async readMeta(attachmentId: string): Promise<AttachmentMeta> {
    const r = await this.http(`/api/rooms/${this.invite.roomId}/attachments/${attachmentId}`);
    if (!r.ok) throw new Error(`attachment unavailable: ${r.status}`);
    const idx = (await r.json()) as { meta: string; metaNonce: string };
    return openMeta(this.keys.metaKey, this.invite.roomId, attachmentId, { ct: idx.meta, nonce: idx.metaNonce });
  }

  // ---------------------------------------------------------------- destroy

  async destroy(): Promise<void> {
    if (!this.creatorToken) throw new Error('only the creator can destroy');
    const res = await this.http(`/api/rooms/${this.invite.roomId}/destroy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creatorToken: this.creatorToken })
    });
    if (!res.ok) throw new Error(`destroy failed: ${res.status}`);
    this.status = 'destroyed';
    this.discardSecrets();
  }

  /**
   * Arms this room's own recovery window, or clears it with `null`. The creator token goes in the
   * body and never in the path: a URL is what ends up in an access log and in browser history, and
   * this string is what lets someone destroy the room.
   */
  async setIdleDelay(ms: number | null): Promise<void> {
    if (!this.creatorToken) throw new Error('only the creator can arm a delay');
    const res = await this.http(`/api/rooms/${this.invite.roomId}/delay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creatorToken: this.creatorToken, idleDelayMs: ms })
    });
    if (!res.ok) throw new Error(`delay refused: ${res.status}`);
  }

  /** What this room is currently held for, as armed by the owner. Header-carried, for the same
   *  reason the write is body-carried. */
  async getIdleDelay(): Promise<number | null> {
    if (!this.creatorToken) throw new Error('only the creator can read the arming');
    const res = await this.http(`/api/rooms/${this.invite.roomId}/delay`, {
      headers: { 'x-poof-creator': this.creatorToken }
    });
    if (!res.ok) throw new Error(`delay read refused: ${res.status}`);
    const body = (await res.json()) as { idleDelayMs?: number | null };
    return body.idleDelayMs ?? null;
  }

  /**
   * The server answers one bit: is this link still usable? A room in its recovery window is,
   * so a device that was offline for a minute can walk back into the same room; a room that ran
   * out of that window is gone for good and the local recovery entry has to go with it.
   */
  async verifyRoomAlive(): Promise<'ACTIVE' | 'DESTROYED' | 'UNKNOWN'> {
    const r = await this.http(`/api/rooms/${this.invite.roomId}/status`);
    if (!r.ok) return 'UNKNOWN';
    const body = (await r.json()) as { joinable?: boolean };
    return body.joinable === true ? 'ACTIVE' : 'DESTROYED';
  }
}

function nickAAD(roomId: string): Uint8Array {
  return utf8(`v1|nick|${roomId}`);
}

function wsUrl(base: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

function decodeFrameBytes(data: unknown): string {
  if (typeof data === 'string') return data;
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
  return bytes ? new TextDecoder().decode(bytes) : '';
}

export const CLIENT_PROTO = PROTO_VERSION;
export { hexToBytes };
