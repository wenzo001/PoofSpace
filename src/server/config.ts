import path from 'node:path';
import { LIMITS } from '../lib/constants';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  roomsDir: string;
  publicBaseUrl: string | null;
  trustProxy: boolean;
  tls: { keyFile: string; certFile: string } | null;
  env: 'development' | 'production' | 'test';
  maxMembersDefault: number;
  maxRooms: number;
  roomIdleTtlMs: number;
  heartbeatServerMs: number;
  heartbeatGraceMs: number;
  slotGraceMs: number;
  pendingUploadTtlMs: number;
  attachmentBytesMax: number;
  roomAttachmentBytesMax: number;
  tempBytesMaxNode: number;
  chunkBytesMax: number;
  connectionsNodeMax: number;
  connectionsPerIpMax: number;
  vacuumFreelistPages: number;
  destroyRetryMs: number;
  /** null means "default beside the database, inside DATA_DIR". */
  adminControlFile: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  csp: string;
}

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Capacity numbers are validated when the process starts, not when a request finally fails:
 * a typo in `MAX_ROOMS` must stop the boot with the offending variable named, rather than
 * silently running a node with no ceiling or an unjoinable room window.
 */
function bounded(
  name: string,
  raw: string | undefined,
  fallback: number,
  opts: { min: number; max: number }
): number {
  const value = raw?.trim();
  if (value === undefined || value === '') return fallback;
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} must be an integer, got "${value}"`);
  const n = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} is out of range: ${value}`);
  if (n < opts.min || n > opts.max) {
    throw new Error(`${name}=${n} is outside the allowed range ${opts.min}..${opts.max}`);
  }
  return n;
}

/**
 * Everything is env-driven so the same build artifact can be reached by LAN IP,
 * public IP, or a domain behind a reverse proxy without a rebuild.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.DATA_DIR ?? env.POOFSPACE_DATA_DIR ?? './data');
  const logLevelRaw = (env.LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel = (['debug', 'info', 'warn', 'error'].includes(logLevelRaw) ? logLevelRaw : 'info') as AppConfig['logLevel'];
  const keyFile = env.TLS_KEY_FILE;
  const certFile = env.TLS_CERT_FILE;

  return {
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 3000),
    dataDir,
    dbFile: env.DB_FILE ? path.resolve(env.DB_FILE) : path.join(dataDir, 'poofspace.sqlite'),
    roomsDir: env.ROOMS_DIR ? path.resolve(env.ROOMS_DIR) : path.join(dataDir, 'rooms'),
    publicBaseUrl: env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/+$/, '') : null,
    trustProxy: bool(env.TRUST_PROXY, false),
    tls: keyFile && certFile ? { keyFile, certFile } : null,
    env: (env.NODE_ENV ?? 'development') as AppConfig['env'],
    maxMembersDefault: bounded('MAX_PARTICIPANTS_PER_ROOM', env.MAX_PARTICIPANTS_PER_ROOM, LIMITS.maxMembersDefault, {
      min: LIMITS.minMembers,
      max: LIMITS.maxMembersHard
    }),
    maxRooms: bounded('MAX_ROOMS', env.MAX_ROOMS, LIMITS.maxRoomsDefault, { min: 1, max: LIMITS.maxRoomsHard }),
    roomIdleTtlMs:
      bounded('ROOM_IDLE_TTL_SECONDS', env.ROOM_IDLE_TTL_SECONDS, LIMITS.roomIdleTtlSeconds, {
        min: 30,
        max: LIMITS.roomIdleTtlMaxSeconds
      }) * 1000,
    heartbeatServerMs: int(env.HEARTBEAT_SERVER_MS, LIMITS.heartbeatServerMs),
    heartbeatGraceMs: int(env.HEARTBEAT_GRACE_MS, LIMITS.heartbeatGraceMs),
    slotGraceMs: int(env.SLOT_GRACE_MS, LIMITS.slotGraceMs),
    pendingUploadTtlMs: int(env.PENDING_UPLOAD_TTL_MS, LIMITS.pendingUploadTtlMs),
    attachmentBytesMax: int(env.ATTACHMENT_BYTES_MAX, LIMITS.attachmentBytesMax),
    roomAttachmentBytesMax: int(env.ROOM_ATTACHMENT_BYTES_MAX, LIMITS.roomAttachmentBytesMax),
    tempBytesMaxNode: bounded('TEMP_BYTES_MAX_NODE', env.TEMP_BYTES_MAX_NODE, LIMITS.tempBytesMaxNode, {
      min: LIMITS.attachmentBytesMax,
      max: 1024 * 1024 * 1024 * 1024
    }),
    chunkBytesMax: int(env.CHUNK_BYTES_MAX, LIMITS.chunkBytesMax),
    connectionsNodeMax: bounded('MAX_CONNECTIONS_NODE', env.MAX_CONNECTIONS_NODE, LIMITS.connectionsNodeMax, {
      min: 1,
      max: 1_000_000
    }),
    connectionsPerIpMax: bounded('MAX_CONNECTIONS_PER_IP', env.MAX_CONNECTIONS_PER_IP, LIMITS.connectionsPerIpMax, {
      min: 1,
      max: 1_000_000
    }),
    vacuumFreelistPages: int(env.VACUUM_FREELIST_PAGES, LIMITS.vacuumFreelistPages),
    destroyRetryMs: int(env.DESTROY_RETRY_MS, LIMITS.destroyRetryMs),
    adminControlFile: env.ADMIN_CONTROL_FILE ? path.resolve(env.ADMIN_CONTROL_FILE) : null,
    logLevel,
    csp:
      env.CSP_OVERRIDE ??
      [
        "default-src 'self'",
        // App Router streams its flight payload in inline <script>self.__next_f.push(...)</script>
        // blocks. Without 'unsafe-inline' the browser refuses them and the page never hydrates,
        // so the room is dead. No third-party origin is ever allowed, and the rest stays strict.
        // React's development build calls eval() to rebuild component stacks, so the dev server
        // refuses to hydrate its own debugging features under this policy. `scripts/dev.mjs` sets
        // NODE_ENV explicitly; anything else - including a production deploy - keeps the stricter
        // string, and tests/security/tls.test.ts goes red the moment 'unsafe-eval' leaks into it.
        env.NODE_ENV === 'development'
          ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
          : "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data:",
        "media-src 'self' blob:",
        "font-src 'self'",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'"
      ].join('; ')
  };
}

export const config = loadConfig();

/**
 * One place decides where the loopback control socket records itself, because the server that
 * writes it and the operator command that reads it must never disagree.
 */
export function adminControlPath(cfg: Pick<AppConfig, 'dataDir' | 'adminControlFile'>): string {
  return cfg.adminControlFile ?? path.join(cfg.dataDir, 'admin-control.json');
}
