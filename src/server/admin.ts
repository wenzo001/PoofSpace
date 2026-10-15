import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { adminControlPath, type AppConfig } from './config';
import type { RoomService } from './service';
import type { WsHub } from './ws';
import { logger } from './log';

/**
 * The operator surface. It is deliberately **not** on the public listener: this is a second
 * socket, bound to the loopback interface, that additionally requires a token only a process
 * with read access to DATA_DIR can obtain. A deployment on 0.0.0.0 therefore has no reachable
 * admin route, no admin button in the home page and no user-role permission system —
 * which is exactly what the specification asks for.
 */
export interface AdminDeps {
  service: RoomService;
  hub: WsHub;
  cfg: AppConfig;
}

export interface AdminControl {
  port: number;
  file: string;
  close(): Promise<void>;
}

const CONFIRM = 'PURGE-ALL-DATA';

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store'
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > 16 * 1024) break;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Counts only. Room ids, invite material and message content never cross this boundary. */
function summary(service: RoomService, hub: WsHub): Record<string, number | boolean> {
  const s = service.stats();
  return {
    paused: service.isPaused(),
    roomsActive: s.roomsActive,
    roomsIdleGrace: s.roomsIdleGrace,
    roomsDestroying: s.roomsDestroying,
    slotsHeld: s.slotsHeld,
    maxRooms: s.maxRooms,
    messages: s.messages,
    attachments: s.attachments,
    online: s.online,
    wsConnections: hub.totalConnections(),
    cleanupPending: service.pendingDestroys().length
  };
}

export async function startAdminControl(deps: AdminDeps): Promise<AdminControl> {
  const { service, hub, cfg } = deps;
  const token = crypto.randomBytes(32).toString('base64url');
  let closed = false;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const peer = req.socket.remoteAddress ?? '';
      // The listener is already loopback-bound; this check is the second lock, so a machine
      // with an unusual routing table cannot answer through another interface.
      if (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') {
        send(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), 'utf8');
      const wanted = Buffer.from(token, 'utf8');
      if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
        send(res, 401, { error: 'AUTH_FAILED', message: 'local admin token required' });
        return;
      }
      if (url.pathname === '/status' && req.method === 'GET') {
        send(res, 200, summary(service, hub));
        return;
      }
      if (url.pathname === '/rooms/disconnect-all' && req.method === 'POST') {
        service.pause();
        // Destroy first so each member is told its room is gone, then mop up the sockets that
        // never joined a room at all. Swapping the order would leave clients with an unexplained
        // disconnect and a room that still exists.
        const { rooms, unfinished } = await service.destroyAllRooms();
        await new Promise((r) => setTimeout(r, 300));
        const connections = hub.closeAll();
        if (unfinished === 0) service.resume();
        send(res, unfinished === 0 ? 200 : 500, {
          ok: unfinished === 0,
          rooms,
          unfinished,
          connections,
          resumed: unfinished === 0,
          ...summary(service, hub)
        });
        return;
      }
      if (url.pathname === '/data/purge-all' && req.method === 'POST') {
        const body = await readJson(req);
        if (body.confirm !== CONFIRM) {
          send(res, 400, { ok: false, error: 'CONFIRMATION_REQUIRED', confirm: CONFIRM });
          return;
        }
        const connections = hub.closeAll();
        const result = await service.purgeAll();
        send(res, result.ok ? 200 : 500, { connections, ...result, ...summary(service, hub) });
        return;
      }
      send(res, 404, { error: 'NOT_FOUND' });
    })().catch((err: unknown) => {
      logger.error('admin control request failed', { err: String(err) });
      if (!res.headersSent) send(res, 500, { ok: false, error: 'INTERNAL' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  // The file is the capability: whoever can read DATA_DIR can run maintenance, nobody else.
  const controlFile = adminControlPath(cfg);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(controlFile, JSON.stringify({ port, token, pid: process.pid, startedAt: Date.now() }, null, 2), {
    mode: 0o600
  });
  logger.info('local admin control listening', { port });

  return {
    port,
    file: controlFile,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        const written = fs.readFileSync(controlFile, 'utf8');
        if (JSON.parse(written).token === token) fs.rmSync(controlFile, { force: true });
      } catch {
        /* already replaced or removed */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export const ADMIN_CONFIRM = CONFIRM;
