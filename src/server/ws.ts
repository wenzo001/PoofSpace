import type { IncomingMessage } from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { ERR, LIMITS, PROTO_VERSION, type RoomDestroyReason } from '../lib/constants';
import type { ClientFrame, ServerFrame } from '../lib/proto';
import { b64ToBytes, bytesToB64 } from '../lib/encoding';
import type { AppConfig } from './config';
import type { RoomService } from './service';
import { logger } from './log';

interface Conn {
  ws: WebSocket;
  challenge: Buffer;
  roomId: string | null;
  slot: number | null;
  gen: number | null;
  outbox: number;
  ip: string;
  counted: boolean;
  lastPongAt: number;
}

/**
 * One WebSocket server sharing the HTTP port so the browser can use same-origin
 * ws:// or wss:// without a second listener or CORS configuration.
 */
export class WsHub {
  readonly wss: WebSocketServer;
  private conns = new WeakMap<WebSocket, Conn>();
  private byRoom = new Map<string, Set<Conn>>();
  private perIp = new Map<string, number>();
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly service: RoomService,
    private readonly cfg: AppConfig
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.service.on('message', (roomId: string, msg) => msg && this.broadcast(roomId, { t: 'msg:new', msg }));
    this.service.on('members', (roomId: string) => {
      const members = this.service.members(roomId);
      this.broadcast(roomId, { t: 'members', members });
    });
    this.service.on('destroying', (roomId: string, reason: string) =>
      this.broadcast(roomId, { t: 'room:destroying', reason: reason as RoomDestroyReason })
    );
    this.service.on('destroyed', (roomId: string, reason: string) => {
      const targets = [...(this.byRoom.get(roomId) ?? [])];
      for (const c of targets) {
        this.send(c, { t: 'room:destroyed', reason: reason as RoomDestroyReason });
      }
      // Give the frame a tick to flush before closing, so clients can show the
      // destroyed state instead of seeing an unexplained disconnect.
      setTimeout(() => {
        for (const c of targets) {
          try {
            c.ws.close(1000, 'destroyed');
          } catch {
            /* already gone */
          }
        }
        this.byRoom.delete(roomId);
      }, 250);
    });
    this.service.on('stale', (roomId: string, slot: number, gen?: number) => {
      for (const c of this.byRoom.get(roomId) ?? []) {
        if (c.slot === slot && (gen === undefined || c.gen === gen)) this.terminate(c, 'stale heartbeat');
      }
    });
    this.startPingLoop();
  }

  private startPingLoop(): void {
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const [, set] of this.byRoom) {
        for (const c of [...set]) {
          // A missed pong is not a dead member. The rule is the same grace the heartbeat sweep
          // uses: silence for a whole grace window. Under load (or with a throttled mobile tab) a
          // pong can easily land one cycle late, and evicting then removes a live participant
          // whose socket is still open and whose messages are still flowing.
          if (now - c.lastPongAt > this.cfg.heartbeatGraceMs) {
            this.terminate(c, 'no pong within the heartbeat grace');
            continue;
          }
          try {
            c.ws.ping();
          } catch {
            this.terminate(c, 'ping failed');
          }
        }
      }
    }, this.cfg.heartbeatServerMs);
    this.pingTimer.unref?.();
  }

  onUpgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer, done?: () => void): void {
    const url = new URL(req.url ?? '/ws', 'http://placeholder');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // A ceiling refused before the handshake: an accepted-then-closed socket still costs a slot
    // in the event loop, which is exactly what a flood of connections is trying to buy.
    if (this.wss.clients.size >= this.cfg.connectionsNodeMax) {
      this.rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    const ip = this.clientKey(req);
    if ((this.perIp.get(ip) ?? 0) >= this.cfg.connectionsPerIpMax) {
      this.rejectUpgrade(socket, 503, 'Too Many Connections');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
      done?.();
    });
  }

  private rejectUpgrade(socket: import('node:net').Socket, status: number, reason: string): void {
    // The handshake never completed, so this is an HTTP refusal, not a WebSocket close frame:
    // 503 says "the node is full", which is what actually happened.
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      socket.end();
    } catch {
      socket.destroy();
    }
  }

  /**
   * Only ever trust the transport-level peer. `X-Forwarded-For` is read when, and only when,
   * the operator said this listener sits behind a proxy they control.
   */
  private clientKey(req: IncomingMessage): string {
    const raw = req.socket.remoteAddress ?? 'unknown';
    if (!this.cfg.trustProxy) return raw;
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    return first || raw;
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const conn: Conn = {
      ws,
      challenge: crypto.randomBytes(32),
      roomId: null,
      slot: null,
      gen: null,
      outbox: 0,
      ip: this.clientKey(req),
      counted: true,
      lastPongAt: Date.now()
    };
    this.perIp.set(conn.ip, (this.perIp.get(conn.ip) ?? 0) + 1);
    this.conns.set(ws, conn);
    ws.on('pong', () => {
      conn.lastPongAt = Date.now();
      // A pong is answered by the network layer, so it proves the peer is there even when the
      // page's own timers are throttled or starved. Refresh the seat on it: an idle-but-connected
      // member must not lose its place in the roster just because its app-level ping lagged.
      if (conn.roomId && conn.slot !== null) {
        this.service.heartbeat(conn.roomId, conn.slot, conn.gen ?? undefined);
      }
    });
    ws.on('message', (data, isBinary) => {
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
      void this.onMessage(conn, text, isBinary).catch((err) => {
        logger.error('ws handler error', { err: String(err) });
        this.send(conn, { t: 'error', code: 'INTERNAL', message: 'internal error' });
      });
    });
    ws.on('close', () => this.drop(conn));
    ws.on('error', () => this.drop(conn));
    const maxMembers = this.cfg.maxMembersDefault;
    this.send(conn, {
      t: 'hello',
      proto: PROTO_VERSION,
      serverNonce: conn.challenge.toString('base64'),
      maxMembers,
      chunkSizeMax: this.cfg.chunkBytesMax
    });
  }

  private drop(conn: Conn): void {
    if (conn.counted) {
      conn.counted = false;
      const left = (this.perIp.get(conn.ip) ?? 1) - 1;
      if (left <= 0) this.perIp.delete(conn.ip);
      else this.perIp.set(conn.ip, left);
    }
    if (conn.roomId && conn.slot !== null) {
      this.service.leave(conn.roomId, conn.slot, conn.gen ?? undefined);
    }
    if (conn.roomId) this.byRoom.get(conn.roomId)?.delete(conn);
    conn.roomId = null;
    conn.slot = null;
    conn.gen = null;
  }

  private async onMessage(conn: Conn, data: string, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.send(conn, { t: 'error', code: 'BAD_FRAME', message: 'binary frames are not accepted' });
      return;
    }
    if (data.length > 512 * 1024) {
      this.send(conn, { t: 'error', code: ERR.tooLarge, message: 'frame too large' });
      return;
    }
    let frame: ClientFrame;
    try {
      frame = JSON.parse(data) as ClientFrame;
    } catch {
      this.send(conn, { t: 'error', code: 'BAD_FRAME', message: 'frame is not JSON' });
      return;
    }
    if (!frame || typeof frame.t !== 'string') {
      this.send(conn, { t: 'error', code: 'BAD_FRAME', message: 'missing frame type' });
      return;
    }
    // Anything a member sends proves it is here, not only its ping frames: a chat partner
    // must not be aged out of the roster just because its heartbeat frame lagged.
    conn.lastPongAt = Date.now();
    if (conn.roomId && conn.slot !== null) {
      this.service.heartbeat(conn.roomId, conn.slot, conn.gen ?? undefined);
    }
    switch (frame.t) {
      case 'ping':
        this.send(conn, { t: 'pong', at: Date.now() });
        return;
      case 'join':
        await this.handleJoin(conn, frame);
        return;
      case 'leave':
        this.drop(conn);
        conn.ws.close(1000, 'bye');
        return;
    }
    if (conn.roomId === null || conn.slot === null || conn.gen === null) {
      this.send(conn, { t: 'error', code: ERR.notMember, message: 'join a room first' });
      return;
    }
    const roomId = conn.roomId;
    const slot = conn.slot;
    const gen = conn.gen;
    switch (frame.t) {
      case 'msg:send': {
        const res = this.service.appendMessage({
          roomId,
          slot,
          gen,
          clientMsgId: frame.clientMsgId,
          kind: frame.kind,
          nonce: b64ToBytes(frame.nonce),
          ct: b64ToBytes(frame.ct),
          attachmentId: frame.attachmentId
        });
        if (res.ok) {
          this.send(conn, {
            t: 'msg:ack',
            reqId: frame.reqId,
            clientMsgId: res.clientMsgId as string,
            seq: res.seq as number,
            at: res.at as number,
            dup: !!res.dup
          });
        } else {
          this.send(conn, { t: 'msg:nack', reqId: frame.reqId, clientMsgId: frame.clientMsgId, code: res.code ?? 'UNKNOWN' });
        }
        return;
      }
      case 'sync': {
        const { msgs, gap } = this.service.since(roomId, frame.sinceSeq);
        if (gap) {
          this.send(conn, { t: 'sync:gap', oldestSeq: this.service.oldestSeq(roomId), headSeq: this.service.headSeq(roomId) });
        } else {
          this.send(conn, { t: 'sync:ok', msgs, fromSeq: frame.sinceSeq, headSeq: this.service.headSeq(roomId) });
        }
        return;
      }
      case 'nick:set':
        this.service.setNick(roomId, slot, b64ToBytes(frame.nick), b64ToBytes(frame.nickNonce));
        return;
      case 'upload:create': {
        const res = this.service.createAttachment({
          roomId,
          slot,
          gen,
          attachmentId: frame.attachmentId,
          chunkSize: frame.chunkSize,
          chunkCount: frame.chunkCount,
          totalBytes: frame.totalBytes,
          meta: b64ToBytes(frame.meta),
          metaNonce: b64ToBytes(frame.metaNonce),
          kind: frame.kind
        });
        if (res.ok) this.send(conn, { t: 'upload:ready', attachmentId: frame.attachmentId, chunkSize: frame.chunkSize, chunkCount: frame.chunkCount });
        else this.send(conn, { t: 'upload:err', attachmentId: frame.attachmentId, code: res.code ?? 'UNKNOWN' });
        return;
      }
      case 'upload:complete': {
        const r = this.service.completeAttachment(roomId, frame.attachmentId, this.tokenOf(conn) ?? '');
        if (r.ok) this.send(conn, { t: 'attachment:ready', attachmentId: frame.attachmentId, chunkCount: r.chunkCount ?? 0 });
        else this.send(conn, { t: 'upload:err', attachmentId: frame.attachmentId, code: r.code ?? ERR.badState });
        return;
      }
      case 'upload:abort':
        this.service.abortAttachment(roomId, frame.attachmentId, this.tokenOf(conn) ?? '');
        this.send(conn, { t: 'upload:err', attachmentId: frame.attachmentId, code: 'ABORTED' });
        return;
      case 'destroy': {
        const res = await this.service.destroy(roomId, 'creator', frame.creatorToken);
        if (!res.ok) this.send(conn, { t: 'error', code: res.code ?? ERR.notCreator, message: 'destroy refused' });
        return;
      }
      default:
        this.send(conn, { t: 'error', code: 'BAD_FRAME', message: 'unknown frame type' });
    }
  }

  private tokens = new WeakMap<Conn, string>();

  setToken(conn: WebSocket, token: string): void {
    const c = this.conns.get(conn);
    if (c) this.tokens.set(c, token);
  }

  private tokenOf(conn: Conn): string | undefined {
    return this.tokens.get(conn);
  }

  private async handleJoin(conn: Conn, frame: Extract<ClientFrame, { t: 'join' }>): Promise<void> {
    const res = this.service.join(
      {
        roomId: frame.roomId,
        proof: b64ToBytes(frame.proof),
        nick: b64ToBytes(frame.nick),
        nickNonce: b64ToBytes(frame.nickNonce)
      },
      conn.challenge
    );
    if (!res.ok) {
      this.send(conn, { t: 'join:err', code: res.code ?? 'UNKNOWN' });
      conn.ws.close(4001, res.code ?? 'rejected');
      return;
    }
    conn.roomId = frame.roomId;
    conn.slot = res.slot ?? null;
    conn.gen = res.gen ?? null;
    if (!this.byRoom.has(frame.roomId)) this.byRoom.set(frame.roomId, new Set());
    this.byRoom.get(frame.roomId)?.add(conn);
    if (res.sessionToken) this.tokens.set(conn, res.sessionToken);
    this.send(conn, {
      t: 'join:ok',
      roomId: frame.roomId,
      slot: res.slot as number,
      gen: res.gen as number,
      headSeq: res.headSeq as number,
      sessionToken: res.sessionToken as string,
      isCreator: !!res.isCreator,
      members: res.members ?? [],
      oldestSeq: res.oldestSeq ?? 0
    });
  }

  private send(conn: Conn, frame: ServerFrame): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.outbox > LIMITS.wsOutboxMax) {
      this.terminate(conn, 'outbox overflow');
      return;
    }
    conn.outbox++;
    const payload = JSON.stringify(frame);
    conn.ws.send(payload, (err) => {
      conn.outbox = Math.max(0, conn.outbox - 1);
      if (err) this.terminate(conn, 'send error');
    });
  }

  private terminate(conn: Conn, reason: string): void {
    try {
      conn.ws.terminate();
    } catch {
      /* ignore */
    }
    this.drop(conn);
    logger.debug('ws connection terminated', { reason });
  }

  private broadcast(roomId: string, frame: ServerFrame): void {
    for (const c of this.byRoom.get(roomId) ?? []) this.send(c, frame);
  }

  /** Buffered amount is tracked per connection so a stalled peer cannot grow a queue. */
  roomConnectionCount(roomId: string): number {
    return this.byRoom.get(roomId)?.size ?? 0;
  }

  totalConnections(): number {
    return this.wss.clients.size;
  }

  closeRoom(roomId: string): void {
    for (const c of [...(this.byRoom.get(roomId) ?? [])]) {
      try {
        c.ws.close(1000, 'room destroyed');
      } catch {
        /* ignore */
      }
    }
    this.byRoom.delete(roomId);
  }

  /**
   * Force every client off the node, including sockets that never joined a room. Terminate
   * rather than close: a client that wants to hang up a graceful close would keep its slot,
   * and the admin command has to be able to promise the connections really went away.
   */
  closeAll(): number {
    let n = 0;
    for (const c of this.wss.clients) {
      try {
        c.terminate();
        n++;
      } catch {
        /* already gone */
      }
    }
    this.byRoom.clear();
    return n;
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const c of this.wss.clients) {
      try {
        c.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export function frameBytes(frame: ServerFrame): string {
  return bytesToB64(Buffer.from(JSON.stringify(frame)));
}
