/**
 * PM2 process definition for the PoofSpace release artifact.
 *
 * Ship this file inside the artifact and start it from the artifact root:
 *
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save                 # resurrect after a host reboot
 *   pm2 status
 *   pm2 logs poofspace
 *   pm2 restart poofspace
 *   pm2 stop poofspace
 *   pm2 delete poofspace
 *
 * Exactly ONE instance, fork mode. PoofSpace keeps its WebSocket connections, room
 * memory and rate-limit buckets in-process on top of a single better-sqlite3 file.
 * Cluster mode would multiply that: members would land on whichever worker their
 * socket happened to bind to, `pm2 reload` would orphan rooms in the dying worker,
 * and two workers writing one SQLite file only buys lock contention. Scale by
 * running this app on more hosts behind a load balancer, not by adding instances.
 *
 * Node.js (>=20.9) and PM2 are prerequisites on the target host; they are NOT
 * bundled in the artifact.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = __dirname;

/**
 * Runtime data must live OUTSIDE the app directory, because a redeploy replaces
 * everything here. Override with DATA_DIR; the default is a persistent per-user path.
 */
function dataDir() {
  return process.env.DATA_DIR || path.join(os.homedir(), '.poofspace', 'data');
}

function logDir() {
  const dir = process.env.LOG_DIR || path.join(os.homedir(), '.poofspace', 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* PM2 will report the real problem if the path is unusable */
  }
  return dir;
}

const DATA = dataDir();
const LOGS = logDir();

const common = {
  name: 'poofspace',
  cwd: root,
  // The packaged custom server, never `next dev` and never the `next` CLI.
  script: path.join('dist', 'server', 'server.js'),
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  watch: false,
  // The server does a graceful close (WebSocket drain + WAL checkpoint) on SIGINT.
  kill_signal: 'SIGINT',
  kill_timeout: 15000,
  wait_ready: false,
  max_memory_restart: process.env.MAX_MEMORY_RESTART || '1G',
  env: {
    NODE_ENV: 'production',
    HOST: process.env.HOST || '0.0.0.0',
    PORT: process.env.PORT || '3000',
    DATA_DIR: DATA,
    DB_FILE: process.env.DB_FILE || path.join(DATA, 'poofspace.sqlite'),
    ROOMS_DIR: process.env.ROOMS_DIR || path.join(DATA, 'rooms'),
    LOG_LEVEL: process.env.LOG_LEVEL || 'info'
  },
  error_file: path.join(LOGS, 'poofspace-error.log'),
  out_file: path.join(LOGS, 'poofspace-out.log'),
  pid_file: path.join(LOGS, 'poofspace.pid'),
  merge_logs: true,
  time: true
};

/**
 * `--env production` merges the env_production block below. The base `env` block is
 * already production-safe, so a bare `pm2 start ecosystem.config.cjs` also runs the
 * compiled server in production mode. Deployment-specific knobs (PUBLIC_BASE_URL,
 * TRUST_PROXY, TLS_KEY_FILE / TLS_CERT_FILE, ...) are passed through from the shell
 * that runs `pm2 start`, so they never need an edit to this file.
 */
const PASS_THROUGH = [
  'PUBLIC_BASE_URL',
  'TRUST_PROXY',
  'TLS_KEY_FILE',
  'TLS_CERT_FILE',
  'CSP_OVERRIDE',
  'MAX_ROOMS',
  'MAX_PARTICIPANTS_PER_ROOM',
  'ROOM_IDLE_TTL_SECONDS',
  'MAX_CONNECTIONS_NODE',
  'MAX_CONNECTIONS_PER_IP',
  'TEMP_BYTES_MAX_NODE',
  'VACUUM_FREELIST_PAGES',
  'DESTROY_RETRY_MS',
  'ADMIN_CONTROL_FILE',
  'HEARTBEAT_SERVER_MS',
  'HEARTBEAT_GRACE_MS',
  'SLOT_GRACE_MS',
  'PENDING_UPLOAD_TTL_MS',
  'ATTACHMENT_BYTES_MAX',
  'ROOM_ATTACHMENT_BYTES_MAX',
  'CHUNK_BYTES_MAX'
];

function passthroughEnv() {
  const pass = {};
  for (const key of PASS_THROUGH) {
    if (process.env[key] !== undefined) pass[key] = process.env[key];
  }
  return pass;
}

// Exactly ONE app: a second PM2 app would mean two processes on one SQLite file.
module.exports = {
  apps: [
    {
      ...common,
      env_production: { ...common.env, ...passthroughEnv(), NODE_ENV: 'production' }
    }
  ]
};
