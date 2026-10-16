#!/usr/bin/env node
/**
 * Reproducible production packaging for PoofSpace.
 *
 *   npm run release            # = node scripts/build-release.mjs
 *
 * Produces:
 *   release/poofspace/              the deployable tree
 *   release/poofspace-deploy.tar.gz the same tree as a tarball
 *
 * What goes in (and only this):
 *   dist/**                  compiled custom server (it owns HTTP + the WS upgrade)
 *   .next/**                 Next production runtime + static assets
 *   public/**                static public assets (if the project has any)
 *   package.json             runtime metadata (npm/PM2 read it)
 *   ecosystem.config.cjs     PM2 definition (fork, 1 instance)
 *   LICENSE / README*.md / CHANGELOG.md / docs/*.md
 *                            the licence must travel with the code an operator will forward on
 *   node_modules/**          the real production dependency closure, incl. the native
 *                            better-sqlite3 binary for THIS os/arch/node abi
 * What must NOT go in: src/, tests/, devDependencies, TypeScript, vitest, a populated
 * data dir. The closure is derived by walking package.json dependencies through
 * node_modules, never by hand-pruning, and the result is printed for audit.
 *
 * Flags:
 *   --no-build       reuse the existing dist/ and .next/ instead of rebuilding; dies if
 *                    either is missing OR predates the current sources
 *   --dry-run        diagnostics: assemble + audit the tree, skip the tarball, and
 *                    (only if .next is genuinely absent) run a reduced boot smoke that
 *                    is labelled as NOT release-verified
 *   --no-smoke       skip the standalone boot test (development convenience only;
 *                    a real release must pass it)
 *   --no-tar         skip the tarball
 *
 * Prerequisites on the BUILD machine: Node >= 20.9 and installed devDependencies
 * (npm ci). The target server needs neither npm install nor a build.
 *
 * The artifact is platform-specific: better-sqlite3 ships a native binary, so build
 * on the target OS/arch (or inside a matching container).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { outputStamp, sourceStamp } from './stamp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const stageOut = path.join(releaseDir, 'poofspace');
const tarball = path.join(releaseDir, 'poofspace-deploy.tar.gz');

const REQUIRED_RUNTIME_PACKAGES = ['better-sqlite3', 'ws', '@noble/ciphers', '@noble/hashes', 'next', 'react', 'react-dom'];
const FORBIDDEN_IN_ARTIFACT = ['src', 'tests', 'node_modules/typescript', 'node_modules/vitest', 'node_modules/@types'];

/**
 * One list decides what documentation travels with the server, so the audit below can require the
 * licence without inventing a second copy of the name. A deployment package that carries the code
 * but not the MIT licence is not a distribution the operator is allowed to forward on.
 */
const SHIPPED_DOCS = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'docs/DEPLOYMENT.md',
  'docs/SECURITY.md',
  'docs/TEST-REPORT.md',
  'docs/ARCHITECTURE.md',
  'docs/DEBT.md'
];
const REQUIRED_DOCS = ['LICENSE', 'README.md', 'docs/DEPLOYMENT.md'];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opts = { noBuild: has('--no-build'), dryRun: has('--dry-run'), noSmoke: has('--no-smoke'), noTar: has('--no-tar') };
for (const a of args) {
  if (!['--no-build', '--dry-run', '--no-smoke', '--no-tar'].includes(a)) {
    if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: node scripts/build-release.mjs [--no-build] [--dry-run] [--no-smoke] [--no-tar]\n');
      process.exit(0);
    }
    die(`unknown flag ${a}`);
  }
}

function die(msg) {
  process.stderr.write(`build-release: ${msg}\n`);
  process.exit(1);
}
function log(msg) {
  process.stdout.write(`[release] ${msg}\n`);
}

function runNode(entry, cliArgs, { inherit = true, cwd = root } = {}) {
  const r = spawnSync(process.execPath, [entry, ...cliArgs], { cwd, encoding: inherit ? undefined : 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
  return { code: r.status ?? 1, stdout: r.stdout?.toString?.() ?? '', stderr: r.stderr?.toString?.() ?? '' };
}

// ------------------------------------------------------------------ 1. build

function ensureBuilds() {
  const nextBuildId = path.join(root, '.next', 'BUILD_ID');
  const serverEntry = path.join(root, 'dist', 'server', 'server.js');
  const srcMs = sourceStamp(root);
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

  if (opts.noBuild) {
    if (!fs.existsSync(serverEntry)) die('--no-build and dist/server/server.js is missing; run npm run build:server first');
    if (!fs.existsSync(nextBuildId)) die('--no-build and .next/BUILD_ID is missing; run npm run build first');
  } else {
    if (!fs.existsSync(tsc)) die(`TypeScript compiler not found at ${path.relative(root, tsc)} - run npm ci on the build machine`);
    log('compiling the custom server: tsc -p tsconfig.server.json');
    const r = runNode(tsc, ['-p', path.join(root, 'tsconfig.server.json')]);
    if (r.code !== 0) die('server compilation failed');
    if (!fs.existsSync(serverEntry)) die('tsc reported success but dist/server/server.js is still missing');

    if (!fs.existsSync(nextBin)) die(`next CLI not found at ${path.relative(root, nextBin)} - run npm ci on the build machine`);
    log('building the web app: next build');
    const b = runNode(nextBin, ['build'], { cwd: root });
    if (b.code !== 0) die('next build failed');
    if (!fs.existsSync(nextBuildId)) {
      if (opts.dryRun) {
        log('WARNING: next build produced no .next/BUILD_ID; continuing the DRY RUN without the Next runtime');
      } else {
        die('next build finished but .next/BUILD_ID is missing');
      }
    }
  }

  // The artifact is a byte-for-byte copy of these outputs, so outputs that predate the
  // sources would ship code that no longer matches the tree being certified.
  const outMs = outputStamp(root);
  if (srcMs > outMs) {
    die(`build outputs predate the sources (src ${new Date(srcMs).toISOString()} > out ${new Date(outMs).toISOString()}); drop --no-build or run npm run build`);
  }
  return { next: fs.existsSync(nextBuildId), server: fs.existsSync(serverEntry), srcMs, outMs };
}

// ------------------------------------------------- 2. production dep closure

/**
 * Walk the real production dependency closure instead of pruning by hand. Resolution
 * mirrors Node's algorithm: a dependency is looked up from the requiring package's
 * directory upwards, so hoisted and nested copies both land at the right relative path.
 */
function productionClosure() {
  const rootNm = path.join(root, 'node_modules');
  if (!fs.existsSync(rootNm)) die('node_modules is missing; run npm ci on the build machine');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const wanted = Object.keys(pkgJson.dependencies ?? {});
  const included = new Map(); // relative path under node_modules -> package name
  const missing = [];
  const skippedOptional = [];
  const stack = wanted.map((name) => ({ name, fromRel: null, parent: '<root>', optional: false }));

  const resolveDir = (name, fromRel) => {
    // fromRel is like "next/node_modules/server-only-thing" style path inside node_modules
    const chain = fromRel === null ? [] : fromRel.split(path.sep);
    for (let depth = chain.length; depth >= 0; depth--) {
      const base = [rootNm, ...chain.slice(0, depth)].join(path.sep);
      const candidate = path.join(base, ...name.split('/'));
      if (fs.existsSync(path.join(candidate, 'package.json'))) return path.relative(rootNm, candidate);
    }
    return null;
  };

  while (stack.length) {
    const item = stack.pop();
    const rel = resolveDir(item.name, item.fromRel);
    if (!rel) {
      // npm only installs the optional dependency that matches this platform, so the other
      // @next/swc and @img/sharp variants are legitimately absent and must not fail the build.
      if (item.optional) skippedOptional.push(item.name);
      else missing.push(`${item.name} (required by ${item.parent})`);
      continue;
    }
    const full = path.join(rootNm, rel);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8'));
    } catch (err) {
      die(`cannot read ${rel}/package.json: ${err.message}`);
    }
    if (included.has(rel)) continue;
    const label = `${meta.name}@${meta.version}`;
    included.set(rel, label);
    for (const d of Object.keys(meta.dependencies ?? {})) stack.push({ name: d, fromRel: rel, parent: label, optional: false });
    for (const d of Object.keys(meta.optionalDependencies ?? {})) stack.push({ name: d, fromRel: rel, parent: label, optional: true });
  }
  return { included, missing, skippedOptional };
}

function dirBytes(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        files++;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* raced */
        }
      }
    }
  }
  return { files, bytes };
}

// -------------------------------------------------------------- 3. assembling

function cp(src, dest, filter = () => true) {
  if (!fs.existsSync(src)) return null;
  fs.cpSync(src, dest, { recursive: true, filter });
  return dest;
}

/** Copy the Next production output minus build scratch (cache/dev/diagnostics/logs). */
function nextFilter(p) {
  const rel = path.relative(path.join(root, '.next'), p);
  if (!rel) return true;
  const segs = rel.split(path.sep);
  if (segs[0] === 'cache' || segs[0] === 'dev' || segs[0] === 'diagnostics') return false;
  if (segs[0] === 'trace' || segs[0] === 'trace-build' || segs[0] === 'package.json') return false;
  const last = segs[segs.length - 1];
  if (/\.(?:log|tsbuildinfo)$/.test(last)) return false;
  return true;
}

function assemble({ included }) {
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.rmSync(stageOut, { recursive: true, force: true });
  fs.mkdirSync(stageOut, { recursive: true });

  log('copying dist/** (compiled custom server)');
  if (!cp(path.join(root, 'dist'), path.join(stageOut, 'dist'))) die('dist/ missing');

  const nextSrc = path.join(root, '.next');
  if (fs.existsSync(nextSrc)) {
    log('copying .next/** (Next production runtime + static assets; cache/dev excluded)');
    fs.cpSync(nextSrc, path.join(stageOut, '.next'), { recursive: true, filter: (p) => nextFilter(p) });
  } else if (opts.dryRun) {
    log('WARNING: .next is absent (dry run) - the artifact has no web runtime');
  } else {
    die('.next is absent; the artifact cannot serve the web app');
  }

  const publicSrc = path.join(root, 'public');
  if (fs.existsSync(publicSrc)) {
    log('copying public/** (static assets served by Next)');
    cp(publicSrc, path.join(stageOut, 'public'));
  } else {
    log('public/ does not exist in the repo; creating an empty one so the documented layout holds');
    fs.mkdirSync(path.join(stageOut, 'public'), { recursive: true });
  }

  log('copying package.json + ecosystem.config.cjs');
  fs.copyFileSync(path.join(root, 'package.json'), path.join(stageOut, 'package.json'));
  fs.copyFileSync(path.join(root, 'ecosystem.config.cjs'), path.join(stageOut, 'ecosystem.config.cjs'));
  if (fs.existsSync(path.join(root, 'package-lock.json'))) {
    fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stageOut, 'package-lock.json'));
  }
  for (const d of SHIPPED_DOCS) {
    const src = path.join(root, d);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.join(stageOut, path.dirname(d)), { recursive: true });
      fs.copyFileSync(src, path.join(stageOut, d));
    }
  }

  // Deliberately NOT copied: src/, tests/, tsconfig*, vitest.config.ts, .env, and any
  // data dir. Runtime data lives in DATA_DIR on persistent disk, outside this tree.
  log(`copying the production node_modules closure (${included.size} package trees)`);
  let nmFiles = 0;
  let nmBytes = 0;
  for (const rel of included.keys()) {
    const src = path.join(root, 'node_modules', rel);
    const dest = path.join(stageOut, 'node_modules', rel);
    fs.cpSync(src, dest, {
      recursive: true,
      filter: (p) => {
        const base = path.basename(p);
        return base !== '.DS_Store' && !base.endsWith('.tsbuildinfo') && !p.endsWith(`${path.sep}test${path.sep}`);
      }
    });
    const stat = dirBytes(dest);
    nmFiles += stat.files;
    nmBytes += stat.bytes;
  }
  return { nmFiles, nmBytes };
}

// ------------------------------------------------------------- 4. audit print

function audit(closure, copied) {
  const rows = [...closure.included.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  process.stdout.write('\n--- artifact audit ------------------------------------------------------------\n');
  process.stdout.write(`built on ${os.platform()}/${os.arch()} node ${process.version} (abi ${process.versions.modules})\n`);
  process.stdout.write(`node_modules: ${rows.length} package trees, ${copied.nmFiles} files, ${(copied.nmBytes / 1048576).toFixed(1)} MiB\n`);
  for (const [rel, id] of rows) process.stdout.write(`  ${rel.padEnd(48)} ${id}\n`);

  const problems = [];
  // Closure keys come from path.relative, so on Windows a scoped package is
  // "@noble\ciphers" while the required list says "@noble/ciphers". Comparing the
  // raw strings would report installed packages as missing.
  const includedPaths = [...closure.included.keys()].map((rel) => rel.split(path.sep).join('/'));
  for (const name of REQUIRED_RUNTIME_PACKAGES) {
    const found = includedPaths.some((rel) => rel === name || rel.endsWith(`/${name}`));
    if (!found) problems.push(`required runtime package missing from the closure: ${name}`);
  }
  const nativeDir = path.join(stageOut, 'node_modules', 'better-sqlite3', 'build', 'Release');
  const natives = fs.existsSync(nativeDir) ? fs.readdirSync(nativeDir).filter((f) => f.endsWith('.node')) : [];
  if (natives.length) process.stdout.write(`native binary: node_modules/better-sqlite3/build/Release/${natives.join(', ')}\n`);
  else problems.push('better-sqlite3 has no compiled native binary for this platform');

  for (const banned of FORBIDDEN_IN_ARTIFACT) {
    if (fs.existsSync(path.join(stageOut, banned))) problems.push(`forbidden path present in the artifact: ${banned}`);
  }
  if (!fs.existsSync(path.join(stageOut, 'dist', 'server', 'server.js'))) problems.push('dist/server/server.js missing');
  if (fs.existsSync(path.join(root, '.next', 'BUILD_ID')) && !fs.existsSync(path.join(stageOut, '.next', 'BUILD_ID'))) problems.push('.next/BUILD_ID missing from the artifact');
  const staticDir = path.join(stageOut, '.next', 'static');
  if (fs.existsSync(path.join(root, '.next', 'BUILD_ID')) && !fs.existsSync(staticDir)) problems.push('.next/static missing from the artifact');
  else if (fs.existsSync(staticDir)) process.stdout.write(`static assets: ${dirBytes(staticDir).files} files under .next/static\n`);

  for (const need of REQUIRED_DOCS) {
    if (!fs.existsSync(path.join(stageOut, need))) problems.push(`${need} is not shipped with the artifact`);
  }
  // Every doc the shipped prose points at must travel with it, or the reader following the pointer
  // lands on nothing. A mention of a path that is not on this branch (the company deployment doc,
  // named in a sentence about what the public line excludes) is prose, not a pointer, so it is only
  // required when the source tree actually has the file.
  const dangling = new Set();
  for (const rel of SHIPPED_DOCS.filter((d) => d.endsWith('.md'))) {
    const staged = path.join(stageOut, rel);
    if (!fs.existsSync(staged)) continue;
    for (const m of fs.readFileSync(staged, 'utf8').matchAll(/docs\/([A-Za-z0-9._-]+\.md)/g)) {
      const target = `docs/${m[1]}`;
      if (target === rel) continue;
      if (!fs.existsSync(path.join(root, target))) continue;
      if (!fs.existsSync(path.join(stageOut, target))) dangling.add(`${rel} points at ${target}, which is not in the artifact`);
    }
  }
  for (const d of dangling) problems.push(d);
  if (!dangling.size) process.stdout.write(`doc references: closed over ${SHIPPED_DOCS.filter((d) => d.endsWith('.md')).length} shipped markdown files\n`);
  const shippedData = ['data', 'poofspace.sqlite'].filter((d) => fs.existsSync(path.join(stageOut, d)));
  if (shippedData.length) problems.push(`runtime data would be shipped: ${shippedData.join(', ')}`);
  else process.stdout.write('runtime data: none shipped (DATA_DIR must point at persistent disk)\n');
  process.stdout.write(`top level: ${fs.readdirSync(stageOut).sort().join(', ')}\n`);
  process.stdout.write('---------------------------------------------------------------------------\n\n');
  if (problems.length) die(`artifact audit failed:\n  - ${problems.join('\n  - ')}`);
  log('artifact audit passed');
}

// --------------------------------------------------------- 5. standalone boot

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function httpGet(url, { timeout = 5000, insecureTls = false } = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout, rejectUnauthorized: insecureTls ? false : undefined }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', (err) => resolve({ status: 0, body: '', error: String(err.message || err) }));
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function pollHealth(url, { timeoutMs, insecureTls }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    const res = await httpGet(url, { insecureTls });
    if (res.status === 200) {
      try {
        const j = JSON.parse(res.body);
        if (j && j.ok === true && typeof j.proto === 'number') return j;
        last = 'payload shape unexpected';
      } catch {
        last = 'payload was not JSON';
      }
    } else {
      last = `status ${res.status || res.error}`;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`health never became ready (${last})`);
}

function httpPost(url, payload, { timeout = 15000, sessionToken = '' } = {}) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload));
    const headers = { 'content-type': 'application/json', 'content-length': body.length };
    if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
    const req = http.request(url, { method: 'POST', timeout, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => resolve({ status: 0, body: String(err.message || err) }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}

// Mirrors hmacJoin() in src/server/service.ts: the server stores only this digest key and
// challenges the client to prove knowledge of it.
const JOIN_INFO = 'poofspace/v1/join';
function joinProof(joinKeyBytes, roomId, challenge) {
  return createHmac('sha256', joinKeyBytes).update(`${JOIN_INFO}|${roomId}|${challenge.toString('hex')}`).digest();
}

// Mirrors src/lib/base32.ts. The smoke has to mint its own room ids because the client
// that normally mints them is browser code and is not part of the server artifact.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function newRoomCredentials() {
  const joinKeyBytes = randomBytes(32);
  return { roomId: base32(randomBytes(16)), joinKeyBytes, joinKey: bytesToB64url(joinKeyBytes) };
}

/** Join a room the way the browser client does, and hand back the session token. */
function joinRoom(port, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('join timed out'));
    }, 10_000);
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.t === 'hello') {
        const proof = joinProof(room.joinKeyBytes, room.roomId, Buffer.from(String(frame.serverNonce), 'base64'));
        ws.send(
          JSON.stringify({
            t: 'join',
            roomId: room.roomId,
            proof: bytesToB64(proof),
            nick: bytesToB64(randomBytes(24)),
            nickNonce: bytesToB64(randomBytes(12))
          })
        );
        return;
      }
      clearTimeout(timer);
      resolve({ ...frame, close: () => ws.close() });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function bytesToB64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// WebSocket frames carry standard base64 (see bytesToB64 in src/lib/encoding.ts); only the
// invite API bodies are base64url. Sending the wrong alphabet makes the server throw.
function bytesToB64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** Open a WS connection against the packaged server and resolve with the first frame. */
function firstFrame(port, pathName = '/ws') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathName}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('ws handshake timed out'));
    }, 10_000);
    ws.on('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Send one frame and resolve with the next reply frame. */
function exchange(port, frame) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('ws reply timed out'));
    }, 10_000);
    let greeted = false;
    ws.on('open', () => {
      /* the server greets first; the join is sent after hello */
    });
    ws.on('message', (raw) => {
      const reply = JSON.parse(String(raw));
      if (!greeted) {
        greeted = true;
        ws.send(JSON.stringify(frame));
        return;
      }
      clearTimeout(timer);
      ws.close();
      resolve(reply);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function startServer(target, dataDir) {
  const nextPresent = fs.existsSync(path.join(target, '.next', 'BUILD_ID'));
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: nextPresent ? 'production' : 'test', // test env skips Next only; never used on a real release
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    LOG_LEVEL: 'warn',
    PUBLIC_BASE_URL: '',
    TRUST_PROXY: ''
  };
  delete env.TLS_KEY_FILE;
  delete env.TLS_CERT_FILE;

  const proc = spawn(process.execPath, [path.join('dist', 'server', 'server.js')], { cwd: target, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  proc.stdout.on('data', (c) => logs.push(c.toString()));
  proc.stderr.on('data', (c) => logs.push(c.toString()));

  const stop = async () => {
    const pid = proc.pid;
    proc.kill('SIGTERM');
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 10_000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    if (!exited) {
      proc.kill('SIGKILL');
      log(`pid ${pid} needed SIGKILL`);
    }
  };

  try {
    const health = await pollHealth(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 60_000, insecureTls: false });
    return { port, pid: proc.pid, nextPresent, logs, health, stop };
  } catch (err) {
    await stop();
    throw new Error(`${err.message}\n--- child output ---\n${logs.join('').split('\n').slice(-40).join('\n')}`);
  }
}

async function readStatus(port, roomId) {
  const r = await httpGet(`http://127.0.0.1:${port}/api/rooms/${roomId}/status`, { timeout: 8000 });
  if (r.status !== 200) throw new Error(`status lookup failed (${r.status} ${r.body || r.error})`);
  return JSON.parse(r.body);
}

/**
 * Verify a tree boots and serves on its own: no src/, no devDependencies, no npm install,
 * no rebuild, temp DATA_DIR. Run once against the staged copy and once against the
 * extracted tarball, because "the directory exists" is not the same claim as
 * "the release archive installs and runs".
 */
async function verifyTree(target, dataDir, label) {
  if (fs.existsSync(path.join(target, 'src')) || fs.existsSync(path.join(target, 'tests'))) {
    throw new Error(`${label}: source or tests leaked into the deployed tree`);
  }
  const live = newRoomCredentials();
  const doomed = newRoomCredentials();

  let srv = await startServer(target, dataDir);
  try {
    if (!srv.nextPresent) log(`${label}: REDUCED CHECKS - no Next runtime in this tree, page tests skipped`);
    else log(`${label}: health ok on 127.0.0.1:${srv.port} (proto=${srv.health.proto}, pid=${srv.pid})`);

    if (srv.nextPresent) {
      const home = await httpGet(`http://127.0.0.1:${srv.port}/`, { timeout: 15000 });
      if (home.status !== 200 || !home.body.includes('<')) throw new Error(`${label}: home page fetch failed (status ${home.status || home.error})`);
      log(`${label}: home page served from the packaged .next runtime`);
    }

    for (const probe of ['/data/poofspace.sqlite', '/poofspace.sqlite', '/data/rooms/index']) {
      const r = await httpGet(`http://127.0.0.1:${srv.port}${probe}`, { timeout: 5000 });
      if (r.body.includes('SQLite format 3')) throw new Error(`${label}: the SQLite database is published as a static resource at ${probe}`);
      if (r.status === 200 && r.headers['content-type'] === 'application/octet-stream') {
        throw new Error(`${label}: a data file is served directly at ${probe}`);
      }
    }
    log(`${label}: runtime data is not published as static content`);

    for (const room of [live, doomed]) {
      const created = await httpPost(`http://127.0.0.1:${srv.port}/api/rooms`, { roomId: room.roomId, joinKey: room.joinKey });
      if (created.status !== 201) throw new Error(`${label}: room create over HTTP returned ${created.status} ${created.body}`);
      const parsed = JSON.parse(created.body);
      if (parsed.roomId !== room.roomId || !parsed.creatorToken) throw new Error(`${label}: create response malformed: ${created.body}`);
      room.creatorToken = parsed.creatorToken;
    }
    const beforeStatus = await readStatus(srv.port, live.roomId);
    if (beforeStatus.joinable !== true) throw new Error(`${label}: freshly created room is not joinable (${JSON.stringify(beforeStatus)})`);
    log(`${label}: room create + status over HTTP IP:port ok`);

    const hello = await firstFrame(srv.port);
    if (hello.t !== 'hello') throw new Error(`${label}: ws did not greet with hello (got ${hello.t})`);
    if (Buffer.from(String(hello.serverNonce), 'base64').length !== 32) throw new Error(`${label}: ws hello carries a malformed server nonce`);
    log(`${label}: websocket upgrade served by the packaged server`);

    const rejected = await exchange(srv.port, {
      t: 'join',
      roomId: live.roomId,
      proof: bytesToB64(Buffer.alloc(32)),
      nick: bytesToB64(Buffer.alloc(16)),
      nickNonce: bytesToB64(Buffer.alloc(12))
    });
    if (rejected.t !== 'join:err' && rejected.t !== 'error') {
      throw new Error(`${label}: a forged join proof was accepted by the packaged server (${JSON.stringify(rejected)})`);
    }
    log(`${label}: join proof without the room secret refused (${rejected.code ?? rejected.t})`);

    const member = await joinRoom(srv.port, doomed);
    if (member.t !== 'join:ok' || !member.sessionToken) throw new Error(`${label}: the real join handshake failed on the packaged server (${JSON.stringify(member)})`);
    log(`${label}: join with the correct proof accepted (slot ${member.slot}, isCreator ${member.isCreator})`);

    const wrongCreator = await httpPost(`http://127.0.0.1:${srv.port}/api/rooms/${doomed.roomId}/destroy`, { creatorToken: 'x'.repeat(43) }, { sessionToken: member.sessionToken });
    if (wrongCreator.status !== 403) {
      member.close();
      throw new Error(`${label}: destroy with a forged creator token returned ${wrongCreator.status} ${wrongCreator.body}, expected 403`);
    }
    log(`${label}: destroy without the creator token refused (403)`);

    const destroyed = await httpPost(
      `http://127.0.0.1:${srv.port}/api/rooms/${doomed.roomId}/destroy`,
      { creatorToken: doomed.creatorToken },
      { sessionToken: member.sessionToken }
    );
    member.close();
    if (destroyed.status !== 200) throw new Error(`${label}: creator destroy returned ${destroyed.status} ${destroyed.body}`);
    const afterDestroy = await readStatus(srv.port, doomed.roomId);
    if (afterDestroy.joinable === true) throw new Error(`${label}: destroy returned 200 but the link is still joinable`);
    const roomDir = path.join(dataDir, 'rooms', doomed.roomId);
    if (fs.existsSync(roomDir) && fs.readdirSync(roomDir).length) throw new Error(`${label}: destroyed room still owns files in ${path.relative(dataDir, roomDir)}`);
    log(`${label}: creator destroy cleaned the room and its temp attachment dir`);
  } finally {
    await srv.stop();
  }

  // A redeploy must not lose runtime data, and a destroyed room must not come back.
  srv = await startServer(target, dataDir);
  try {
    const survived = await readStatus(srv.port, live.roomId);
    // A restart kills every socket, so the room comes back in its recovery window: joinable is
    // the claim that matters, and it is the one the invite holder experiences.
    if (survived.joinable !== true) throw new Error(`${label}: SQLite data did not survive the restart (${JSON.stringify(survived)})`);
    const revived = await readStatus(srv.port, doomed.roomId);
    if (revived.joinable === true) throw new Error(`${label}: a destroyed room came back after restart`);
    const rejoin = await exchange(srv.port, {
      t: 'join',
      roomId: live.roomId,
      proof: bytesToB64(Buffer.alloc(32)),
      nick: bytesToB64(Buffer.alloc(16)),
      nickNonce: bytesToB64(Buffer.alloc(12))
    });
    if (rejoin.t === 'join:ok') throw new Error(`${label}: the packaged server accepted a forged join proof after restart`);
    log(`${label}: restart kept the room joinable inside its recovery window and did not revive the destroyed room`);
  } finally {
    await srv.stop();
  }
  return srv.nextPresent;
}

/**
 * Copy the artifact to a throwaway directory and verify it there, so the staged tree is
 * proven independent of the repository it was built in.
 */
async function smokeBoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poofspace-release-smoke-'));
  const target = path.join(tmp, 'poofspace');
  const dataDir = path.join(tmp, 'runtime-data');
  try {
    fs.cpSync(stageOut, target, { recursive: true });
    return await verifyTree(target, dataDir, 'copy');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------------- 6. tar

function makeTarball() {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    die('`tar` is required to produce release/poofspace-deploy.tar.gz and was not found on PATH (install it, or ship release/poofspace/ directly)');
  }
  fs.rmSync(tarball, { force: true });
  // Git Bash tar reads "D:\path" as "host:path" for a remote archive, so both the archive
  // name and the member path have to stay relative to the working directory.
  const r = spawnSync('tar', ['-czf', path.basename(tarball), path.basename(stageOut)], { cwd: releaseDir, encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(tarball)) die(`tar failed: ${r.stderr || r.status}`);
  log(`tarball: ${path.relative(root, tarball)} (${(fs.statSync(tarball).size / 1048576).toFixed(1)} MiB)`);
}

/** Extract the tarball into a clean directory and verify the tree that a deploy sees. */
async function verifyTarball() {
  // The scratch directory lives under release/ so the archive can be named with a
  // relative path: GNU tar under MSYS reads "D:\path" as a remote "host:path".
  const tmp = fs.mkdtempSync(path.join(releaseDir, 'extract-'));
  const target = path.join(tmp, 'poofspace');
  const dataDir = path.join(tmp, 'runtime-data');
  try {
    const r = spawnSync('tar', ['-xzf', `..${path.sep}${path.basename(tarball)}`], { cwd: tmp, encoding: 'utf8' });
    if (r.status !== 0) die(`extracting the tarball failed: ${r.stderr || r.status}`);
    if (!fs.existsSync(path.join(target, 'dist', 'server', 'server.js'))) die('the extracted archive has no dist/server/server.js');
    log(`extracted ${path.basename(tarball)} into ${path.relative(root, tmp)}`);
    return await verifyTree(target, dataDir, 'extract');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

// --------------------------------------------------------------------- main

const started = Date.now();
log(`project root ${root}`);
const built = ensureBuilds();
const closure = productionClosure();
if (closure.missing.length) {
  die(`unresolved production dependencies: ${closure.missing.join(', ')}`);
}
const copied = assemble(closure);
audit(closure, copied);

let fullSmoke = false;
let copyVerified = false;
let extractVerified = false;

function failBoot(stage, err) {
  process.stderr.write(`build-release: ${stage} FAILED: ${err && err.message ? err.message : String(err)}\n`);
  die(`the release artifact could not be verified to run on its own (${stage}); refusing to publish it`);
}

if (opts.noSmoke) {
  log('--no-smoke: the standalone boot test was SKIPPED. This artifact is NOT verified.');
} else {
  try {
    fullSmoke = await smokeBoot();
    copyVerified = true;
  } catch (err) {
    failBoot('staged copy boot', err);
  }
}

if (opts.dryRun) {
  log('DRY RUN: tarball not written. Audit above is real, but do not ship a dry-run tree.');
} else if (opts.noTar) {
  log('--no-tar: tarball skipped, so the archive was never extracted or booted');
} else {
  makeTarball();
  if (opts.noSmoke) {
    log('--no-smoke: the extracted tarball was NOT booted');
  } else {
    try {
      await verifyTarball();
      extractVerified = true;
    } catch (err) {
      failBoot('extracted tarball boot', err);
    }
  }
}

fs.writeFileSync(
  path.join(releaseDir, 'build-info.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      sourceNewestMs: built.srcMs,
      outputNewestMs: built.outMs,
      durationMs: Date.now() - started,
      platform: os.platform(),
      arch: os.arch(),
      node: process.version,
      abi: process.versions.modules,
      nextBuildId: fs.existsSync(path.join(root, '.next', 'BUILD_ID')) ? fs.readFileSync(path.join(root, '.next', 'BUILD_ID'), 'utf8').trim() : null,
      smoke: opts.noSmoke ? 'skipped' : fullSmoke ? 'standalone-production-boot' : 'standalone-server-only',
      stagedCopyVerified: copyVerified,
      extractedTarballVerified: extractVerified,
      dryRun: !!opts.dryRun,
      packages: [...closure.included.entries()].map(([rel, id]) => ({ path: rel.split(path.sep).join('/'), id }))
    },
    null,
    2
  )
);
log(`wrote ${path.relative(root, path.join(releaseDir, 'build-info.json'))}`);
log('done');
