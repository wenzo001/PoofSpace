#!/usr/bin/env node
/**
 * Local development launcher.
 *
 * The custom Node server already drives Next in dev mode (src/server/server.ts calls
 * next({ dev: cfg.env === 'development' })), so ONE process serves HMR pages, /api/*
 * and the /ws upgrade on the same port. Running `next dev` separately would just
 * fight over the port and give you no WebSocket.
 *
 * Flow: compile the server (tsc -p tsconfig.server.json) -> start dist/server/server.js
 * with NODE_ENV=development -> on any change under src/server or src/lib, recompile and
 * restart the child we started (never anything else).
 *
 *   node scripts/dev.mjs [--port 3000] [--host 127.0.0.1] [--data-dir <dir>] [--no-watch]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const serverEntry = path.join(root, 'dist', 'server', 'server.js');
const watchDirs = [path.join(root, 'src', 'server'), path.join(root, 'src', 'lib')];
const watchFiles = [path.join(root, 'tsconfig.server.json'), path.join(root, 'tsconfig.json')];

function parseArgs(argv) {
  const opts = { port: process.env.PORT ?? '3000', host: process.env.HOST ?? '127.0.0.1', dataDir: process.env.DATA_DIR ?? null, watch: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = String(argv[++i]);
    else if (a === '--host') opts.host = String(argv[++i]);
    else if (a === '--data-dir') opts.dataDir = String(argv[++i]);
    else if (a === '--no-watch') opts.watch = false;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: node scripts/dev.mjs [--port N] [--host H] [--data-dir DIR] [--no-watch]\n');
      process.exit(0);
    } else {
      process.stderr.write(`dev: unknown option ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const childEnv = {
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(opts.port),
  HOST: String(opts.host),
  DATA_DIR: opts.dataDir ?? path.join(root, 'data')
};

let child = null;
let stopping = false;
let restartQueued = false;

function info(msg) {
  process.stdout.write(`[dev] ${msg}\n`);
}

function runCompiler() {
  return new Promise((resolve) => {
    const args = ['-p', path.join(root, 'tsconfig.server.json')];
    const useLocal = fs.existsSync(tscBin);
    const cmd = useLocal ? process.execPath : 'npx';
    const cmdArgs = useLocal ? [tscBin, ...args] : ['-y', 'typescript', ...args];
    const p = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: childEnv });
    p.on('error', (err) => {
      info(`could not start the TypeScript compiler: ${err.message}`);
      resolve(false);
    });
    p.on('exit', (code) => resolve(code === 0));
  });
}

function readDevLock() {
  const file = path.join(root, '.next', 'dev', 'lock');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.pid === 'number' ? { file, pid: parsed.pid, port: parsed.port } : null;
  } catch {
    return { file, pid: null, port: null };
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err != null && err.code === 'EPERM';
  }
}

/**
 * Next refuses to start a second dev server, and the refusal is aimed at the process that holds
 * `.next/dev/lock`. Say it before spawning anything: otherwise the child dies in under a second,
 * the restart below respawns it, and one actionable line becomes an unreadable loop.
 */
function checkDevLock() {
  const lock = readDevLock();
  if (!lock) return true;
  if (lock.pid && pidAlive(lock.pid)) {
    process.stderr.write(
      `dev: Next already has a dev server for this directory (PID ${lock.pid}${lock.port ? `, port ${lock.port}` : ''}).\n` +
        `     Stop that one (taskkill /PID ${lock.pid} /F) or use another port with --port N.\n`
    );
    return false;
  }
  info(`clearing a stale Next dev lock (PID ${lock.pid ?? 'unknown'} is gone)`);
  try {
    fs.rmSync(lock.file, { force: true });
  } catch {
    /* Next will overwrite it */
  }
  return true;
}

// A child that dies within a second of starting is not a crash worth recovering from - it is the
// same refusal waiting on the other side of the restart. Two of those in a row and the loop stops.
const FAST_EXIT_MS = 8_000;
let fastExits = 0;

function startServer() {
  if (stopping) return;
  const startedAt = Date.now();
  const proc = spawn(process.execPath, ['--enable-source-maps', serverEntry], {
    cwd: root,
    stdio: 'inherit',
    env: childEnv
  });
  child = proc;
  proc.on('exit', (code, signal) => {
    if (child !== proc) return; // a restart already replaced it
    child = null;
    if (stopping) return;
    const ranFor = Date.now() - startedAt;
    if (code !== 0 && ranFor < FAST_EXIT_MS && ++fastExits >= 2) {
      process.stderr.write(
        `dev: the server stopped ${fastExits} times within ${Math.round(FAST_EXIT_MS / 1000)}s of starting (last code=${code}).\n` +
          `     It is refusing to boot, not crashing - most often that is Next's "another dev server is already running".\n` +
          `     Check .next/dev/lock, or start on another port: node scripts/dev.mjs --port N\n`
      );
      process.exit(1);
    }
    if (ranFor >= FAST_EXIT_MS) fastExits = 0;
    info(`server exited (code=${code} signal=${signal}) after ${Math.round(ranFor / 1000)}s; restarting in 1s (Ctrl+C to stop)`);
    setTimeout(startServer, 1000);
  });
  info(`http://${opts.host}:${opts.port}  (pages, /api and /ws share this origin)`);
}

function stopEverything(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child) {
    const pid = child.pid;
    child.kill('SIGINT');
    // The server's SIGINT handler closes the DB and exits; force only if it lingers.
    setTimeout(() => {
      if (child && child.pid === pid && child.exitCode === null) {
        info(`child ${pid} did not exit, terminating it`);
        child.kill();
      }
    }, 5000).unref?.();
  }
  setTimeout(() => process.exit(code), 200).unref?.();
}

process.on('SIGINT', () => stopEverything(130));
process.on('SIGTERM', () => stopEverything(143));

async function restart(reason) {
  if (stopping || restartQueued) return;
  restartQueued = true;
  info(`change detected (${reason}) -> recompiling`);
  if (child) {
    const dying = child;
    child = null;
    dying.kill('SIGINT');
    await new Promise((r) => (dying.exitCode === null ? dying.once('exit', r) : r()));
  }
  const ok = await runCompiler();
  restartQueued = false;
  if (!ok) {
    info('compile failed; the server is stopped. Fix the error and save again.');
    return;
  }
  startServer();
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
}

info('compiling the custom server (tsc -p tsconfig.server.json)');
const ok = await runCompiler();
if (!ok) {
  process.stderr.write('dev: server compilation failed\n');
  process.exit(1);
}
if (!fs.existsSync(serverEntry)) {
  process.stderr.write(`dev: expected ${path.relative(root, serverEntry)} after compiling; not found\n`);
  process.exit(1);
}
if (!checkDevLock()) process.exit(1);
startServer();

if (opts.watch) {
  const queue = debounce((why) => void restart(why), 400);
  for (const dir of watchDirs) {
    if (!fs.existsSync(dir)) continue;
    fs.watch(dir, { persistent: false }, (_event, filename) => queue(filename ?? dir));
  }
  for (const file of watchFiles) {
    if (!fs.existsSync(file)) continue;
    fs.watch(file, { persistent: false }, () => queue(path.basename(file)));
  }
  info(`watching ${watchDirs.map((d) => path.relative(root, d)).join(', ')} (Ctrl+C stops)`);
}
