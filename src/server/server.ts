import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { config as defaultConfig, loadConfig, type AppConfig } from './config';
import { Db } from './db';
import { RoomStorage } from './storage';
import { RoomService } from './service';
import { WsHub } from './ws';
import { handleApi, type ApiDeps } from './http-api';
import { startAdminControl, type AdminControl } from './admin';
import { logger, setLogLevel } from './log';

export interface RunningServer {
  server: http.Server | https.Server;
  service: RoomService;
  hub: WsHub;
  storage: RoomStorage;
  db: Db;
  cfg: AppConfig;
  port: number;
  admin: AdminControl;
  close(): Promise<void>;
}

type NextHandler = (req: http.IncomingMessage, res: http.ServerResponse, parsed: { pathname: string }) => Promise<void>;
type NextUpgrade = (req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void;

/**
 * Only headers we can honestly guarantee. The fragment with the invite secret never
 * reaches this process, and `no-referrer` plus `origin-when-cross-origin` keep it
 * out of outbound requests too.
 */
export function securityHeaders(cfg: AppConfig, isSecure: boolean): Record<string, string> {
  return {
    'content-security-policy': cfg.csp + (isSecure ? '; upgrade-insecure-requests' : ''),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'notifications=(self), camera=(), microphone=(), geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-store',
    'strict-transport-security': isSecure ? 'max-age=31536000; includeSubDomains' : ''
  };
}

export function resolveOrigin(req: http.IncomingMessage, cfg: AppConfig): string {
  if (cfg.publicBaseUrl) return cfg.publicBaseUrl;
  const forwardedProto = cfg.trustProxy ? firstHeader(req.headers['x-forwarded-proto']) : undefined;
  const forwardedHost = cfg.trustProxy ? firstHeader(req.headers['x-forwarded-host']) : undefined;
  const proto = forwardedProto ?? (isTls(req) ? 'https' : 'http');
  const host = forwardedHost ?? req.headers.host ?? `localhost:${cfg.port}`;
  return `${proto}://${host}`;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function isTls(req: http.IncomingMessage): boolean {
  const socket = req.socket as import('node:tls').TLSSocket & { encrypted?: boolean };
  return !!socket.encrypted || socket.getProtocol?.() !== undefined;
}

export async function createServer(overrideCfg: Partial<AppConfig> = {}): Promise<RunningServer> {
  const cfg: AppConfig = { ...loadConfig(), ...overrideCfg };
  setLogLevel(cfg.logLevel);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.roomsDir, { recursive: true });

  const db = new Db(cfg.dbFile);
  const storage = new RoomStorage(cfg.roomsDir);
  const service = new RoomService(db, storage, cfg);
  const hub = new WsHub(service, cfg);
  const startedAt = Date.now();

  const recovery = await service.recoverOnStartup();
  if (recovery.active.length || recovery.finishing.length) {
    logger.info('startup recovery', {
      activeRooms: recovery.active.length,
      finishingRooms: recovery.finishing.length
    });
  }
  service.start();

  let nextHandler: NextHandler | null = null;
  let nextUpgrade: NextUpgrade | null = null;
  if (cfg.env !== 'test') {
    const nextPkg = await import('next');
    const nextFactory = (nextPkg as unknown as { default: typeof import('next').default }).default ?? (nextPkg as unknown as typeof import('next').default);
    const app = nextFactory({ dev: cfg.env === 'development', dir: process.cwd() });
    await app.prepare();
    const handler = app.getRequestHandler();
    // Next's dev client opens a WebSocket under /_next/ for hot reload. If that upgrade is
    // refused the client never finishes booting: the page renders, React never hydrates, and
    // every button on the screen is inert. Only dev serves that path.
    if (cfg.env === 'development') nextUpgrade = app.getUpgradeHandler();
    nextHandler = (req, res, parsed) =>
      handler(req, res, parsed as unknown as Parameters<typeof handler>[2]);
  }

  const deps: ApiDeps = { service, storage, cfg, hub, startedAt };

  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const headers = securityHeaders(cfg, isTls(req));
    for (const [k, v] of Object.entries(headers)) if (v) res.setHeader(k, v);
    try {
      const parsed = parseUrl(req.url ?? '/');
      if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, deps);
        if (handled) return;
      }
      if (!nextHandler) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      await nextHandler(req, res, parsed);
    } catch (err) {
      logger.error('request failed', { err: String(err) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  };

  const server = cfg.tls
    ? https.createServer({ key: fs.readFileSync(cfg.tls.keyFile), cert: fs.readFileSync(cfg.tls.certFile) }, onRequest)
    : http.createServer(onRequest);

  server.on('upgrade', (req, socket, head) => {
    const parsed = parseUrl(req.url ?? '/ws');
    if (parsed.pathname === '/ws') {
      hub.onUpgrade(req, socket as import('node:net').Socket, head);
      return;
    }
    // Only the dev runtime owns other upgrade paths (`/_next/hmr`). In production this server
    // accepts exactly one upgrade path, so an unknown upgrade still loses its socket.
    if (nextUpgrade && parsed.pathname.startsWith('/_next/')) {
      nextUpgrade(req, socket as unknown as import('node:stream').Duplex, head);
      return;
    }
    socket.destroy();
  });

  server.on('clientError', (_err, socket) => {
    if ((socket as import('node:net').Socket).writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;

  const admin = await startAdminControl({ service, hub, cfg });

  return {
    server,
    service,
    hub,
    storage,
    db,
    cfg: { ...cfg, port },
    port,
    admin,
    async close(): Promise<void> {
      service.stop();
      await admin.close();
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.checkpoint();
      db.close();
    }
  };
}

function parseUrl(raw: string): { pathname: string } {
  const q = raw.indexOf('?');
  const pathname = (q === -1 ? raw : raw.slice(0, q)) || '/';
  return { pathname: decodeURIComponent(pathname.split('#')[0] as string) };
}

export async function main(): Promise<RunningServer> {
  const running = await createServer({});
  logger.info('PoofSpace listening', {
    host: running.cfg.host,
    port: running.port,
    dataDir: running.cfg.dataDir,
    tls: !!running.cfg.tls,
    env: running.cfg.env
  });
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info('shutting down', { signal });
    try {
      await running.close();
    } catch (err) {
      logger.error('shutdown error', { err: String(err) });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { reason: String(reason) }));
  return running;
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('fatal startup error', { err: String(err) });
    process.exit(1);
  });
}
