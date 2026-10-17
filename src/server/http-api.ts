import type { IncomingMessage, ServerResponse } from 'node:http';
import { ERR, LIMITS, PROTO_VERSION } from '../lib/constants';
import { b64urlToBytes } from '../lib/encoding';
import { isCanonicalRoomId } from '../lib/crypto/invite';
import type { AppConfig } from './config';
import type { RoomService } from './service';
import type { RoomStorage } from './storage';
import type { WsHub } from './ws';
import { logger } from './log';

export interface ApiDeps {
  service: RoomService;
  storage: RoomStorage;
  cfg: AppConfig;
  hub: WsHub;
  startedAt: number;
}

const ATT_ID_RE = /^[0-9a-f]{32}$/;

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
}

function fail(res: ServerResponse, code: number, errCode: string, message: string): void {
  json(res, code, { error: errCode, message });
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Same-origin guard for state-changing calls. A cross-site POST could otherwise
 * burn slots or trigger destroys from a victim's browser session.
 */
function sameOrigin(req: IncomingMessage, cfg: AppConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const hostHeader = String(req.headers.host ?? '');
    if (cfg.publicBaseUrl) {
      const base = new URL(cfg.publicBaseUrl);
      if (o.host === base.host) return true;
    }
    return o.host === hostHeader;
  } catch {
    return false;
  }
}

function token(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return String(req.headers['x-poof-session'] ?? '');
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  if (!url.pathname.startsWith('/api/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const { service, cfg } = deps;

  if (url.pathname === '/api/health') {
    // Liveness only. Room counts, connection totals and any other runtime aggregate stay off
    // the public listener: they would turn this endpoint into a status page for the node and
    // give an outside caller something to enumerate.
    json(res, 200, { ok: true, proto: PROTO_VERSION });
    return true;
  }

  if (url.pathname === '/api/runtime-config') {
    json(res, 200, {
      proto: PROTO_VERSION,
      maxMembersDefault: cfg.maxMembersDefault,
      limits: {
        historyPageSize: LIMITS.historyPageSize,
        chunkBytes: LIMITS.chunkBytes,
        chunkBytesMax: cfg.chunkBytesMax,
        attachmentBytesMax: cfg.attachmentBytesMax,
        textPlaintextBytes: LIMITS.textPlaintextBytes,
        uploadConcurrencyMax: LIMITS.uploadConcurrencyMax,
        msgPerSecond: LIMITS.msgPerSecond,
        roomIdleTtlMs: cfg.roomIdleTtlMs
      },
      publicBaseUrl: cfg.publicBaseUrl,
      publicBaseUrlConfigured: !!cfg.publicBaseUrl
    });
    return true;
  }

  if (method === 'POST' && !sameOrigin(req, cfg)) {
    fail(res, 403, ERR.authFailed, 'cross-origin request rejected');
    return true;
  }

  if (url.pathname === '/api/rooms' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    if (!body) return fail(res, 413, ERR.tooLarge, 'body too large'), true;
    let parsed: { roomId?: string; joinKey?: string; maxMembers?: number };
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return fail(res, 400, 'BAD_FRAME', 'body is not JSON'), true;
    }
    if (!parsed.roomId || !isCanonicalRoomId(parsed.roomId)) return fail(res, 400, 'BAD_ROOM_ID', 'room id malformed'), true;
    if (!parsed.joinKey) return fail(res, 400, 'BAD_JOIN_KEY', 'join key required'), true;
    let joinKey: Uint8Array;
    try {
      joinKey = b64urlToBytes(parsed.joinKey);
    } catch {
      return fail(res, 400, 'BAD_JOIN_KEY', 'join key malformed'), true;
    }
    if (joinKey.length !== 32) return fail(res, 400, 'BAD_JOIN_KEY', 'join key must be 32 bytes'), true;
    const exists = service.status(parsed.roomId);
    if (exists.status !== 'UNKNOWN') return fail(res, 409, ERR.badState, 'room id already used'), true;
    try {
      const created = service.createRoom(parsed.roomId, joinKey, parsed.maxMembers ?? cfg.maxMembersDefault);
      if (!created.ok) {
        // One line, no numbers: whether the node holds 19 or 190 rooms is not the caller's
        // business, and a count here is a probe for anyone watching refusals.
        const code = created.code === ERR.capacityFull ? ERR.capacityFull : ERR.maintenance;
        return fail(res, 503, code, code === ERR.capacityFull ? '暂时无法创建新房间，请稍后再试' : '服务正在维护，请稍后再试'), true;
      }
      json(res, 201, { roomId: parsed.roomId, creatorToken: created.creatorToken });
    } catch (err) {
      logger.error('room create failed', { err: String(err) });
      fail(res, 500, 'INTERNAL', 'could not create room');
    }
    return true;
  }

  const m = /^\/api\/rooms\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!m) return fail(res, 404, 'NOT_FOUND', 'no such endpoint'), true;
  const roomId = m[1] as string;
  const rest = m[2] ?? '';
  if (!isCanonicalRoomId(roomId)) return fail(res, 400, 'BAD_ROOM_ID', 'room id malformed'), true;

  if (rest === '/status' && method === 'GET') {
    // One bit answers: can a holder of this link still get in? Who is online and what the room
    // is called are only for members, over the authenticated socket, never for an anonymous probe.
    json(res, 200, { joinable: service.status(roomId).joinable });
    return true;
  }

  const auth = service.authorizeToken(token(req), roomId);
  if (!auth) return fail(res, 401, ERR.authFailed, 'valid room session required'), true;

  if (rest === '/messages' && method === 'GET') {
    const before = Number(url.searchParams.get('beforeSeq') ?? '') || undefined;
    const limit = Number(url.searchParams.get('limit') ?? '') || undefined;
    const page = service.history(roomId, { beforeSeq: before, limit });
    json(res, 200, { msgs: page.msgs, hasMore: page.hasMore, oldestSeq: page.oldestSeq });
    return true;
  }

  if (rest === '/destroy' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    if (!body) return fail(res, 413, ERR.tooLarge, 'body too large'), true;
    let creatorToken = '';
    try {
      creatorToken = String((JSON.parse(body.toString('utf8')) as { creatorToken?: string }).creatorToken ?? '');
    } catch {
      /* handled below */
    }
    const res2 = await service.destroy(roomId, 'creator', creatorToken);
    if (!res2.ok) return fail(res, res2.code === ERR.roomNotFound ? 404 : 403, res2.code ?? ERR.notCreator, 'destroy refused'), true;
    json(res, 200, { destroyed: true, verifiedEmpty: res2.report?.verifiedEmpty ?? false });
    return true;
  }

  if (rest === '/delay' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    if (!body) return fail(res, 413, ERR.tooLarge, 'body too large'), true;
    let creatorToken = '';
    let idleDelayMs: number | null = null;
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { creatorToken?: string; idleDelayMs?: number | null };
      creatorToken = String(parsed.creatorToken ?? '');
      idleDelayMs = parsed.idleDelayMs === null || parsed.idleDelayMs === undefined ? null : Number(parsed.idleDelayMs);
    } catch {
      return fail(res, 400, 'BAD_BODY', 'malformed body'), true;
    }
    // The creator token travels in the body, never in the path or query: a URL is what ends up in
    // access logs and in a browser's history. Session authorization already happened above, so a
    // caller has to hold both the room session and the owner credential.
    const out = service.setIdleDelay(roomId, creatorToken, idleDelayMs);
    if (!out.ok) return fail(res, out.code === ERR.roomNotFound ? 404 : 403, out.code ?? ERR.notCreator, 'delay refused'), true;
    json(res, 200, { idleDelayMs });
    return true;
  }

  if (rest === '/delay' && method === 'GET') {
    const out = service.idleDelayFor(roomId, String(req.headers['x-poof-creator'] ?? ''));
    if (!out.ok) return fail(res, out.code === ERR.roomNotFound ? 404 : 403, out.code ?? ERR.notCreator, 'unavailable'), true;
    json(res, 200, { idleDelayMs: out.idleDelayMs ?? null });
    return true;
  }

  const attMatch = /^\/attachments\/([^/]+)(\/chunks\/(\d+))?$/.exec(rest);
  if (attMatch) {
    const attachmentId = attMatch[1] as string;
    if (!ATT_ID_RE.test(attachmentId)) return fail(res, 400, 'BAD_ATTACHMENT', 'attachment id malformed'), true;
    const chunkIdx = attMatch[3] !== undefined ? Number(attMatch[3]) : null;

    if (chunkIdx !== null && method === 'GET') {
      const idx = service.attachmentIndex(roomId, attachmentId);
      if (!idx) return fail(res, 404, ERR.attachmentNotFound, 'attachment gone'), true;
      const buf = await deps.storage.readChunk(roomId, attachmentId, chunkIdx);
      if (!buf) return fail(res, 404, ERR.attachmentNotFound, 'chunk not uploaded'), true;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': buf.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      });
      res.end(buf);
      return true;
    }

    if (chunkIdx === null && method === 'GET') {
      const idx = service.attachmentIndex(roomId, attachmentId);
      if (!idx) return fail(res, 404, ERR.attachmentNotFound, 'attachment gone'), true;
      json(res, 200, idx);
      return true;
    }
  }

  const upMatch = /^\/uploads\/([^/]+)(\/chunks\/(\d+)|\/complete)?$/.exec(rest);
  if (upMatch) {
    const attachmentId = upMatch[1] as string;
    if (!ATT_ID_RE.test(attachmentId)) return fail(res, 400, 'BAD_ATTACHMENT', 'attachment id malformed'), true;
    if (upMatch[3] !== undefined && method === 'PUT') {
      const index = Number(upMatch[3]);
      const declared = Number(req.headers['content-length'] ?? '0');
      if (declared > cfg.chunkBytesMax + 64) return fail(res, 413, ERR.tooLarge, 'chunk too large'), true;
      const frame = await readBody(req, cfg.chunkBytesMax + 64);
      if (!frame) return fail(res, 413, ERR.tooLarge, 'chunk too large'), true;
      const r = await service.writeChunk(roomId, attachmentId, index, new Uint8Array(frame), token(req));
      if (!r.ok) return fail(res, r.code === ERR.roomDestroyed ? 410 : 400, r.code ?? 'UPLOAD_FAILED', 'chunk rejected'), true;
      json(res, 200, { ok: true, index, bytes: r.bytes });
      return true;
    }
    if (upMatch[2] === '/complete' && method === 'POST') {
      const r = service.completeAttachment(roomId, attachmentId, token(req));
      if (!r.ok) return fail(res, 400, r.code ?? 'BAD_STATE', 'upload incomplete'), true;
      json(res, 200, { ok: true, chunkCount: r.chunkCount });
      return true;
    }
    if (method === 'DELETE') {
      service.abortAttachment(roomId, attachmentId, token(req));
      json(res, 200, { ok: true });
      return true;
    }
  }

  return fail(res, 404, 'NOT_FOUND', 'no such endpoint'), true;
}
