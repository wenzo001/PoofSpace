#!/usr/bin/env node
/**
 * Acceptance gate runner.
 *
 *   npm run gates                       # everything, strict
 *   npm run gates -- --list             # print the manifest and exit
 *   npm run gates -- --only=B3,B4       # subset
 *   npm run gates -- --allow-skip       # a SKIP is reported but does not fail the run
 *   npm run gates -- --json out.json    # machine-readable report
 *
 * Every gate maps to a sentence in the project specification and is decided by running
 * something real. Nothing here re-states a result as passing because it looked likely:
 * a gate whose prerequisite is absent reports SKIP, and SKIP exits non-zero unless
 * --allow-skip is given, so a skipped security or stress test can never be read as a
 * pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { sourceStamp } from './stamp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const artifact = path.join(releaseDir, 'poofspace');
const require_ = createRequire(path.join(root, 'noop.js'));

const argv = process.argv.slice(2);
const OPTS = {
  list: argv.includes('--list'),
  allowSkip: argv.includes('--allow-skip'),
  quick: argv.includes('--quick'),
  only: (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean)
};
const jsonOut = (() => {
  const i = argv.indexOf('--json');
  return i >= 0 ? argv[i + 1] : null;
})();

function run(cmd, args, { cwd = root, env = {}, timeoutMs = 20 * 60_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', shell: process.platform === 'win32', timeout: timeoutMs });
  return {
    code: r.status ?? (r.error ? -1 : 0),
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    error: r.error ? String(r.error.message) : null
  };
}

function vitest(lanes, timeoutMs = 15 * 60_000, extra = []) {
  const cli = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(cli)) return { code: -1, out: `vitest is missing at ${path.relative(root, cli)}` };
  return run(process.execPath, [cli, 'run', '--reporter=dot', ...lanes, ...extra], { timeoutMs });
}

function summarise(raw) {
  // vitest colorizes even when piped, and the escapes sit between the label and the number
  // ("\u001b[2m Test Files \u001b[22m \u001b[32m2 passed\u001b[39m"), so a regex over the raw bytes
  // reported "0 files, 0 tests" for lanes that had just printed their counts.
  const out = raw.replace(/\u001b\[[0-9;]*m/g, '');
  const tests = /Tests\s+(\d+) passed(?:\s*\((\d+)\))?/.exec(out);
  const failed = /Tests\s+\d+ failed/.test(out);
  const files = /Test Files\s+(\d+) passed/.exec(out);
  return {
    tests: tests ? Number(tests[1]) : 0,
    files: files ? Number(files[1]) : 0,
    failed,
    tail: out.split('\n').filter(Boolean).slice(-14).join(' | ').slice(0, 1400)
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function req(method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        timeout: 10000,
        headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) }
      },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c).toString('utf8') }));
      }
    );
    r.on('error', (err) => resolve({ status: 0, body: String(err.message) }));
    r.on('timeout', () => r.destroy());
    r.end(data);
  });
}

async function pollHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await req('GET', url);
    if (r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

function pm2Bin() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pm2'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (probe.status !== 0) return null;
  return probe.stdout.split(/\r?\n/)[0].trim();
}

function readBuildInfo() {
  const f = path.join(releaseDir, 'build-info.json');
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

let browserLaneCache = null;
async function browserLane() {
  if (browserLaneCache === null) {
    const mod = await import('./run-browser-tests.mjs');
    browserLaneCache = await mod.runBrowserLane({ quiet: true });
  }
  return browserLaneCache;
}

function browserGate(names) {
  return async () => {
    const lane = await browserLane();
    const hits = lane.results.filter((r) => names.some((n) => r.name.startsWith(n)));
    if (!hits.length) return { status: 'SKIP', evidence: `the browser lane reported nothing for ${names.join(', ')}` };
    const fail = hits.find((r) => r.status === 'FAIL');
    const skip = hits.find((r) => r.status === 'SKIP');
    return {
      status: fail ? 'FAIL' : skip ? 'SKIP' : 'PASS',
      evidence: hits.map((r) => `${r.name}=${r.status} (${r.detail})`).join('; ')
    };
  };
}

/**
 * Read the release script's own report rather than re-deriving it, and prove the report
 * is fresh: a stale build-info.json from an earlier run must not certify today's tree.
 */
function releaseReport() {
  const info = readBuildInfo();
  if (!info) return { info: null, reason: 'release/build-info.json is missing; run npm run release' };
  const tar = path.join(releaseDir, 'poofspace-deploy.tar.gz');
  if (!fs.existsSync(tar)) return { info: null, reason: 'release/poofspace-deploy.tar.gz is missing; run npm run release' };
  if (fs.statSync(tar).mtimeMs > fs.statSync(path.join(releaseDir, 'build-info.json')).mtimeMs) {
    return { info: null, reason: 'build-info.json is older than the tarball; the report does not describe the current artifact' };
  }
  if (typeof info.sourceNewestMs !== 'number') {
    return { info: null, reason: 'build-info.json carries no source stamp; it cannot certify today\'s tree — run npm run release' };
  }
  // The artifact is a copy of what was built, so a tree that moved after packing is not the
  // tree B2/B3/B5 are describing.
  const srcNow = sourceStamp(root);
  if (srcNow > info.sourceNewestMs) {
    return {
      info: null,
      reason: `the tree changed after the artifact was packed (src now ${new Date(srcNow).toISOString()} > packed ${new Date(info.sourceNewestMs).toISOString()}); run npm run release`
    };
  }
  return { info, reason: '' };
}

// ------------------------------------------------------------------ the gates

// One place names which lane owns which test directory. A gate that silently stops covering a
// file is how a suite goes green while a directory rots, so T6 diffs this list against the disk.
const LANES = {
  T1: ['tests/unit', 'tests/integration'],
  T2: ['tests/security'],
  T3: ['tests/lifecycle'],
  T4: ['tests/perf'],
  T6: ['tests/capacity', 'tests/storage', 'tests/admin']
};

const GATES = [
  {
    id: 'B1',
    title: 'npm run build from a clean tree (typecheck + next build + server tsc)',
    spec: '补充规范 七.1',
    run: () => {
      const t = run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--noEmit'], { timeoutMs: 8 * 60_000 });
      const t2 = run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.server.json', '--noEmit'], { timeoutMs: 8 * 60_000 });
      // npm is a .cmd shim on Windows: spawning it without a shell fails before the script
      // runs, and the gate then reports a build that never happened.
      const build = run('npm', ['run', 'build'], { timeoutMs: 15 * 60_000 });
      const out = build.out;
      const ok = t.code === 0 && t2.code === 0 && build.code === 0;
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `client tsc=${t.code === 0 ? 'ok' : 'fail'} server tsc=${t2.code === 0 ? 'ok' : `fail: ${t.out.slice(-200)}`} next build=${build.code === 0 ? 'ok' : `exit ${build.code}: ${out.split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 240)}`}`
      };
    }
  },
  {
    id: 'B2',
    title: 'artifact carries the production closure, the native sqlite binary and the static assets',
    spec: '补充规范 三 / 七.2',
    run: () => {
      const { info, reason } = releaseReport();
      if (!info) return { status: 'SKIP', evidence: reason };
      const natives = fs.existsSync(path.join(artifact, 'node_modules', 'better-sqlite3', 'build', 'Release'))
        ? fs.readdirSync(path.join(artifact, 'node_modules', 'better-sqlite3', 'build', 'Release')).filter((f) => f.endsWith('.node'))
        : [];
      const statics = path.join(artifact, '.next', 'static');
      const staticCount = fs.existsSync(statics) ? countFiles(statics) : 0;
      const banned = ['src', 'tests', 'data', 'node_modules/typescript', 'node_modules/vitest'].filter((p) => fs.existsSync(path.join(artifact, p)));
      const expected = ['better-sqlite3', 'ws', '@noble/ciphers', '@noble/hashes', 'next', 'react', 'react-dom'];
      const present = new Set(info.packages.map((p) => p.id.slice(0, p.id.lastIndexOf('@'))));
      const missing = expected.filter((n) => !present.has(n));
      const abiOk = natives.length > 0;
      const ok = info.smoke !== 'skipped' && !banned.length && !missing.length && abiOk && staticCount > 0;
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `${info.packages.length} packages (${info.platform}/${info.arch}/node ${info.node}); native=${natives.join(',') || 'NONE'}; static files=${staticCount}; forbidden present=${banned.join(',') || 'none'}; missing=${missing.join(',') || 'none'}`
      };
    }
  },
  {
    id: 'B3',
    title: 'the staged tree and the extracted tarball both boot standalone and serve API+WS',
    spec: '补充规范 三 / 七.3',
    run: () => {
      const { info, reason } = releaseReport();
      if (!info) return { status: 'SKIP', evidence: reason };
      if (!info.stagedCopyVerified || !info.extractedTarballVerified) {
        return { status: 'FAIL', evidence: `smoke=${info.smoke} stagedCopyVerified=${info.stagedCopyVerified} extractedTarballVerified=${info.extractedTarballVerified} (build at ${info.builtAt})` };
      }
      return { status: 'PASS', evidence: `smoke=${info.smoke}; build ${info.builtAt}; nextBuildId=${info.nextBuildId}; both the copied tree and the untarred tree were booted and exercised` };
    }
  },
  {
    id: 'B4',
    title: 'PM2 starts the packaged server (fork, 1 instance), restarts it, runs the shipped admin command and stops it',
    spec: '补充规范 四 / 七.4',
    run: async () => {
      const pm2 = pm2Bin();
      if (!pm2) return { status: 'SKIP', evidence: 'pm2 is not installed on this machine; the packaged server was still booted directly (B3)' };
      if (!fs.existsSync(path.join(artifact, 'ecosystem.config.cjs'))) return { status: 'SKIP', evidence: 'release/poofspace is missing; run npm run release' };
      const port = await freePort();
      const data = path.join(os.tmpdir(), `poofspace-pm2-${Date.now()}`);
      const logs = path.join(data, 'logs');
      const list = () => run(pm2, ['jlist'], { timeoutMs: 60_000 });
      const start = run(pm2, ['start', path.join(artifact, 'ecosystem.config.cjs'), '--env', 'production'], {
        env: { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, LOG_DIR: logs, LOG_LEVEL: 'info' },
        timeoutMs: 3 * 60_000
      });
      if (start.code !== 0) return { status: 'FAIL', evidence: `pm2 start failed: ${start.out.slice(-400)}` };
      const healthy = await pollHealth(`http://127.0.0.1:${port}/api/health`, 60_000);
      const single = (() => {
        try {
          const apps = JSON.parse(list().out || '[]');
          const me = apps.find((a) => a.name === 'poofspace');
          return { apps: apps.length, mode: me?.pm2_env?.exec_mode, instances: me?.pm2_env?.instances, online: me?.pm2_env?.status === 'online' };
        } catch {
          return { apps: -1 };
        }
      })();
      const created = await req('POST', `http://127.0.0.1:${port}/api/rooms`, { roomId: randRoomId(), joinKey: randB64url(32) });
      const restart = run(pm2, ['restart', 'poofspace'], { timeoutMs: 2 * 60_000 });
      const healthy2 = await pollHealth(`http://127.0.0.1:${port}/api/health`, 60_000);
      const status = created.status === 201 ? await req('GET', `http://127.0.0.1:${port}/api/rooms/${JSON.parse(created.body).roomId}/status`) : { status: 0, body: 'no room' };
      // After a restart no socket survived, so the room is in its recovery window: the claim
      // under test is that the data is still there and the invite still reaches it.
      const survived = status.status === 200 && JSON.parse(status.body).joinable === true;
      const doomedRoomId = status.status === 200 ? JSON.parse(created.body).roomId : '';
      // The operator commands are part of the artifact (package.json scripts + dist/server/admin-cli.js),
      // so the gate runs the *shipped* command against the *shipped* server and then checks the
      // effect over HTTP. An exit code alone would only prove the script printed something.
      const admin = run('npm', ['run', 'admin:rooms:disconnect-all', '--', '--yes'], {
        cwd: artifact,
        env: { DATA_DIR: data, PORT: String(port) },
        timeoutMs: 3 * 60_000
      });
      const afterAdmin = doomedRoomId
        ? await req('GET', `http://127.0.0.1:${port}/api/rooms/${doomedRoomId}/status`)
        : { status: 0, body: '' };
      const adminCleaned = admin.code === 0 && /rooms=1/.test(admin.out) && /unfinished=0/.test(admin.out);
      const adminEffect = afterAdmin.status === 200 && JSON.parse(afterAdmin.body).joinable === false;
      const stop = run(pm2, ['delete', 'poofspace'], { timeoutMs: 2 * 60_000 });
      fs.rmSync(data, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      // pm2 reports fork mode as 'fork_mode' in jlist but the config says 'fork'; both spellings
      // mean the same single-process mode, so the gate normalizes instead of pinning one version.
      const forkMode = single.mode === 'fork' || single.mode === 'fork_mode';
      const ok = healthy && healthy2 && restart.code === 0 && stop.code === 0 && forkMode && single.instances === 1 && survived && adminCleaned && adminEffect;
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `health before=${healthy} after restart=${healthy2}; exec_mode=${single.mode} instances=${single.instances}; create=${created.status}${created.status === 201 ? '' : ` body=${created.body.slice(0, 140)}`}; room joinable after pm2 restart=${survived}; shipped admin disconnect-all exit=${admin.code} cleaned=${adminCleaned} effect=${adminEffect} out=${admin.out.replace(/\s+/g, ' ').slice(-160)}; restart exit=${restart.code} delete exit=${stop.code}`
      };
    }
  },
  {
    id: 'B5',
    title: 'SQLite and room temp data survive a process restart and are not shipped or overwritten',
    spec: '补充规范 五 / 七.5',
    run: () => {
      const { info, reason } = releaseReport();
      if (!info) return { status: 'SKIP', evidence: reason };
      const shipped = ['data', 'data/poofspace.sqlite', 'data/rooms'].filter((p) => fs.existsSync(path.join(artifact, p)));
      const ok = !shipped.length && info.stagedCopyVerified && info.extractedTarballVerified;
      return {
        status: ok ? 'PASS' : 'FAIL',
        evidence: `runtime data shipped in the artifact: ${shipped.join(',') || 'none'}; a room created before a restart was still joinable after it, and a destroyed room did not come back (verified inside both boot lanes of build ${info.builtAt})`
      };
    }
  },
  {
    id: 'B6',
    title: 'HTTP IP:port and HTTPS both create, join and use a room',
    spec: '补充规范 一 / 七.6',
    run: async () => {
      const a = await browserGate(['insecure context crypto'])();
      const b = await browserGate(['https lock tooltip', 'history decrypts'])();
      if (a.status === 'SKIP' || b.status === 'SKIP') return { status: 'SKIP', evidence: `${a.evidence} | ${b.evidence}` };
      const ok = a.status === 'PASS' && b.status === 'PASS';
      return { status: ok ? 'PASS' : 'FAIL', evidence: `http+ip: ${a.evidence} | https: ${b.evidence}` };
    }
  },
  {
    id: 'B7',
    title: 'app-layer encryption, auth and history are exercised in a real browser in both modes',
    spec: '补充规范 七.7',
    run: browserGate(['insecure context crypto', 'history decrypts', 'home two entries'])
  },
  {
    id: 'B8',
    title: 'WebSocket works over http, wss and after an abnormal drop',
    spec: '补充规范 一 / 七.8',
    run: () => {
      const r = vitest(['tests/security', 'tests/lifecycle']);
      const s = summarise(r.out);
      if (r.code !== 0 && !s.tests) return { status: 'FAIL', evidence: s.tail || `vitest could not run (${r.code})` };
      return { status: r.code === 0 && !s.failed ? 'PASS' : 'FAIL', evidence: `${s.files} security+lifecycle files, ${s.tests} tests green; wss handshake, proxy-trust, reconnect/gap backfill and destroy-vs-reconnect are asserted there` };
    }
  },
  {
    id: 'B9',
    title: 'a missing security-context API never falls back to plaintext',
    spec: '补充规范 七.9',
    run: browserGate(['no rng no send', 'insecure context crypto'])
  },
  {
    id: 'B10',
    title: 'the lock tooltip states the real protocol and makes no false assurance',
    spec: '补充规范 六 / 七.10',
    run: browserGate(['http lock tooltip', 'https lock tooltip'])
  },
  {
    id: 'T1',
    title: 'functional lane: create / share / join / restore, nicknames, paging, capacity',
    spec: '正文 十一 功能',
    run: () => {
      const r = vitest(LANES.T1);
      const s = summarise(r.out);
      return { status: r.code === 0 && !s.failed && s.tests > 0 ? 'PASS' : r.code === -1 ? 'SKIP' : 'FAIL', evidence: `${s.files} files, ${s.tests} tests${s.failed ? ' with failures' : ''}: ${s.tail}` };
    }
  },
  {
    id: 'T2',
    title: 'security lane: no plaintext at rest, no server-side decrypt, forged proof/replay/cross-room refused',
    spec: '正文 十一 安全',
    run: () => {
      const r = vitest(LANES.T2);
      const s = summarise(r.out);
      return { status: r.code === 0 && !s.failed && s.tests > 0 ? 'PASS' : 'FAIL', evidence: `${s.files} files, ${s.tests} tests${s.failed ? ' with failures' : ''}: ${s.tail}` };
    }
  },
  {
    id: 'T3',
    title: 'lifecycle lane: ACTIVE to IDLE_GRACE(300s) to DESTROYING to DESTROYED, restart, credential expiry',
    spec: '正文 十一 生命周期 / 补充规范 一',
    run: () => {
      const r = vitest(LANES.T3, 20 * 60_000);
      const s = summarise(r.out);
      return { status: r.code === 0 && !s.failed && s.tests > 0 ? 'PASS' : 'FAIL', evidence: `${s.files} files, ${s.tests} tests${s.failed ? ' with failures' : ''}: ${s.tail}` };
    }
  },
  {
    id: 'T4',
    title: 'performance lane: 100 members, broadcast, reconnect churn, upload alongside text, no growth',
    spec: '正文 十一 性能 / 十',
    run: () => {
      const r = vitest(LANES.T4, 25 * 60_000, ['--no-file-parallelism']);
      const s = summarise(r.out);
      return { status: r.code === 0 && !s.failed && s.tests > 0 ? 'PASS' : 'FAIL', evidence: `${s.files} files, ${s.tests} tests${s.failed ? ' with failures' : ''}: ${s.tail}` };
    }
  },
  {
    id: 'T5',
    title: 'real browser lane (renders, encrypts, scrolls, tooltips)',
    spec: '正文 十二 第六阶段',
    run: async () => {
      const lane = await browserLane();
      return {
        status: lane.status,
        evidence: lane.results.map((r) => `${r.name}=${r.status}`).join('; ')
      };
    }
  },
  {
    id: 'T6',
    title: 'governance lane: MAX_ROOMS accounting, no-long-term-storage cleanup, local admin commands',
    spec: '补充规范 二/三/四/五/八',
    run: () => {
      const unclaimed = unclaimedTestFiles();
      if (unclaimed.length) {
        return { status: 'FAIL', evidence: `test files no lane runs: ${unclaimed.join(', ')} - add the directory to LANES` };
      }
      const r = vitest(LANES.T6, 20 * 60_000, ['--no-file-parallelism']);
      const s = summarise(r.out);
      if (r.code !== 0 && !s.tests) return { status: 'FAIL', evidence: s.tail || `vitest could not run (${r.code})` };
      return {
        status: r.code === 0 && !s.failed && s.tests > 0 ? 'PASS' : 'FAIL',
        evidence: `${s.files} files, ${s.tests} tests${s.failed ? ' with failures' : ''}: every tests/ directory is claimed by a lane; capacity ledger + refusal wording, residue scan over sqlite/wal/shm and the attachment tree, disconnect-all and purge-all exit codes`
      };
    }
  }
];

/** Test files on disk that no lane in LANES would run. */
function unclaimedTestFiles() {
  const covered = Object.values(LANES).flat();
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // Forward slashes on purpose: LANES names its directories that way, on every platform.
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.test.ts') && !covered.some((lane) => full === lane || full.startsWith(`${lane}/`))) out.push(full);
    }
  };
  walk('tests');
  return out;
}

function countFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      else n++;
    }
  }
  return n;
}

// Room ids have to be canonical base32 (the server re-encodes after decoding and rejects any
// drift), so the gate encodes with the product's own encoder instead of picking a letter per
// byte - the last character carries padding bits that a per-byte choice gets wrong.
const { base32Encode } = require_('./dist/lib/base32.js');
function randRoomId() {
  return base32Encode(new Uint8Array(require_('node:crypto').randomBytes(16)));
}
function randB64url(n) {
  return Buffer.from(require_('node:crypto').randomBytes(n)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ----------------------------------------------------------------------- main

if (OPTS.list) {
  for (const g of GATES) process.stdout.write(`${g.id.padEnd(4)} ${g.spec.padEnd(24)} ${g.title}\n`);
  process.exit(0);
}

process.stdout.write(`gates: ${GATES.length} defined; running in ${root}\n`);
if (!fs.existsSync(path.join(root, 'dist', 'server', 'server.js'))) {
  process.stdout.write('dist/server/server.js is missing - run npm run build first.\n');
  process.exit(1);
}

const report = [];
for (const g of GATES) {
  if (OPTS.only.length && !OPTS.only.includes(g.id)) continue;
  const t0 = Date.now();
  process.stdout.write(`> ${g.id} ${g.title}\n`);
  let out;
  try {
    out = await g.run();
  } catch (err) {
    out = { status: 'FAIL', evidence: `gate threw: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err}` };
  }
  report.push({ id: g.id, title: g.title, spec: g.spec, ...out, ms: Date.now() - t0 });
  process.stdout.write(`  ${out.status} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${out.evidence.slice(0, 300)}\n`);
}

const fails = report.filter((r) => r.status === 'FAIL');
const skips = report.filter((r) => r.status === 'SKIP');
process.stdout.write('\n=============================== acceptance report ===============================\n');
for (const r of report) process.stdout.write(`${r.status.padEnd(4)} ${r.id.padEnd(4)} ${r.title}\n`);
process.stdout.write(`\n${report.length - fails.length - skips.length} passed, ${fails.length} failed, ${skips.length} skipped\n`);
process.stdout.write('A SKIP is never a pass. The build/deploy items above are decided by the listed evidence.\n');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));

const exit = fails.length ? 1 : skips.length && !OPTS.allowSkip ? 1 : 0;
process.exit(exit);
