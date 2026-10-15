#!/usr/bin/env node
/**
 * Real-browser lane. This is the only place that can answer what the node lanes cannot:
 * what the page actually renders, whether the app still encrypts when the browser denies
 * it a security context, and whether the lock tooltip matches the protocol in use.
 *
 *   node scripts/run-browser-tests.mjs [--quiet] [--json] [--headed]
 *
 * Every check reports PASS / FAIL / SKIP. SKIP only when a prerequisite is genuinely
 * absent (no playwright-core, no LAN address to bind, no built server, no openssl);
 * the lane then exits non-zero, because a skipped security test is never a pass.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTTPS_COPY = '消息和文件在设备端加密，服务器无法直接读取内容。当前连接使用 HTTPS。';
const HTTP_COPY = '消息和文件采用端到端加密，但 HTTP 连接本身未加密，网络中的攻击者可能篡改网页代码。建议在不可信网络中使用 HTTPS。';
const compact = (s) => s.replace(/\s+/g, '');

/**
 * A plain http page on loopback is a secure context in chromium, so crypto.subtle stays
 * available and the fallback path never runs. A made-up hostname that still resolves to
 * 127.0.0.1 is not: it reproduces exactly what an operator sees at http://<lan ip>:port
 * (no subtle, RNG still present) without depending on the machine being able to hairpin
 * to its own LAN address, which is unreliable here.
 */
const INSECURE_HOST = 'poof.insecure';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '0.0.0.0', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/**
 * Interfaces come back in an arbitrary order and a VPN adapter is usually /32, which a
 * browser often cannot hairpin back to. Real subnets first; the probe below still decides.
 */
function candidateAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (String(i.family) !== 'IPv4' || i.internal) continue;
      out.push({ address: i.address, name, pointToPoint: i.netmask === '255.255.255.255' });
    }
  }
  out.sort((a, b) => Number(a.pointToPoint) - Number(b.pointToPoint));
  return [...new Map(out.map((o) => [o.address, o])).values()];
}

function getJson(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    // The lane's own self-signed certificate is expected here; nothing about the app
    // changes - the browser context gets ignoreHTTPSErrors for the same reason.
    const req = lib.get(url, { timeout: 5000, rejectUnauthorized: false }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', (err) => resolve({ status: 0, body: String(err.message) }));
    req.on('timeout', () => req.destroy());
  });
}

async function waitHealth(base, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';
  while (Date.now() < deadline) {
    const r = await getJson(`${base}/api/health`);
    if (r.status === 200) return r.body;
    last = `${r.status} ${r.body}`.slice(0, 140);
    await new Promise((res) => setTimeout(res, 400));
  }
  throw new Error(`${base} never became healthy (${last})`);
}

function bootServer(env, logs) {
  const proc = spawn(process.execPath, [path.join('dist', 'server', 'server.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => logs.push(String(c)));
  proc.stderr.on('data', (c) => logs.push(String(c)));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 8000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  };
  return { pid: proc.pid, stop };
}

/**
 * Self-signed certificate covering the addresses the browser will visit. The lane does
 * not install it as a trusted root; chromium is launched with ignoreHTTPSErrors for this
 * context only. The self-check is that the SAN really lists those addresses, otherwise
 * "https mode" would be testing a certificate for something else.
 */
function makeCert(dir, hosts) {
  const cnf = path.join(dir, 'leaf.cnf');
  const key = path.join(dir, 'leaf.key');
  const crt = path.join(dir, 'leaf.crt');
  fs.writeFileSync(
    cnf,
    [
      '[ req ]',
      'distinguished_name = dn',
      'x509_extensions = v3_req',
      'prompt = no',
      '[ dn ]',
      'CN = PoofSpace Browser Lane',
      '[ v3_req ]',
      'basicConstraints = CA:FALSE',
      'keyUsage = critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage = serverAuth',
      'subjectAltName = @alt_names',
      '[ alt_names ]',
      ...hosts.map((h, i) => `IP.${i + 1} = ${h}`),
      ''
    ].join('\n')
  );
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-config', cnf], { cwd: dir, stdio: 'ignore' });
  const text = execFileSync('openssl', ['x509', '-in', crt, '-noout', '-text'], { cwd: dir, encoding: 'utf8' });
  for (const host of hosts) {
    if (!text.includes(host)) throw new Error(`the generated certificate does not list ${host} in its SAN`);
  }
  return { key, crt };
}

function loadPlaywright() {
  for (const base of [path.join(root, 'noop.js'), path.join(os.homedir(), 'noop.js')]) {
    const req = createRequire(base);
    for (const name of ['playwright-core', 'playwright']) {
      try {
        return { pw: req(name), from: name };
      } catch {
        /* next resolution root */
      }
    }
  }
  return null;
}

/**
 * The browser revision playwright-core asks for is not necessarily the one sitting in the
 * local ms-playwright cache, and downloading one is not this script's call to make. Use
 * an installed chromium build if there is one, and report SKIP if there is not.
 */
function findChromium() {
  if (process.env.POOFSPACE_CHROME && fs.existsSync(process.env.POOFSPACE_CHROME)) return process.env.POOFSPACE_CHROME;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    '/root/.cache/ms-playwright'
  ].filter(Boolean);
  const names = [
    ['chrome-win64', 'chrome.exe'],
    ['chrome-win', 'chrome.exe'],
    ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
    ['Linux64', 'chrome-headless-shell'],
    ['Linux', 'chrome']
  ];
  const builds = [];
  for (const base of roots) {
    if (!fs.existsSync(base)) continue;
    for (const dir of fs.readdirSync(base)) {
      if (!/^chromium(_headless_shell)?-\d+$/.test(dir)) continue;
      for (const parts of names) {
        const exe = path.join(base, dir, ...parts);
        if (fs.existsSync(exe)) builds.push({ rev: Number(/(\d+)$/.exec(dir)[1]), exe });
      }
    }
  }
  builds.sort((a, b) => b.rev - a.rev);
  return builds.length ? builds[0].exe : null;
}

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
}

/**
 * Reaching one's own LAN address from the browser is not reliable on every machine
 * (VPN and firewall stacks intercept it differently), so navigation retries. A retry
 * that never succeeds still fails the check - it is not silently swallowed.
 */
async function gotoPage(page, url, attempts = 4) {
  let last = 'no attempt';
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    } catch (err) {
      last = String(err.message || err).split('\n')[0];
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`navigating to ${url} failed ${attempts} times: ${last}`);
}

/**
 * Does this origin really land the page in a non-secure context in this browser build?
 * The lane needs that to be true before any of the http checks mean anything.
 */
async function loadsAsInsecureContext(browser, origin) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await gotoPage(page, `${origin}/`);
    const caps = await page.evaluate(() => ({ secure: window.isSecureContext, subtle: !!(window.crypto && window.crypto.subtle) }));
    return {
      ok: caps.secure === false && caps.subtle === false,
      detail: `${origin}: isSecureContext=${caps.secure}, crypto.subtle present=${caps.subtle}`
    };
  } catch (err) {
    return { ok: false, detail: `${origin}: ${String(err.message || err).split('\n')[0]}` };
  } finally {
    await context.close();
  }
}

// ------------------------------------------------------------------ the checks

/**
 * http://127.0.0.1 and http://localhost are secure contexts in chromium, so the insecure
 * case only reproduces on a routable non-loopback address - and a browser cannot always
 * hairpin back through a VPN adapter. Each candidate is therefore probed in the real
 * browser, and the address that both loads and reports no secure context is the one used.
 */
async function pickInsecureOrigin(browser, port, candidates) {
  const tried = [];
  for (const c of candidates) {
    const origin = `http://${c.address}:${port}`;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const secure = await page.evaluate(() => window.isSecureContext);
      if (secure === false) return { origin, tried: [...tried, `used ${origin} on ${c.name}`] };
      tried.push(`${origin} (${c.name}): secure context, cannot reproduce the insecure case`);
    } catch (err) {
      tried.push(`${origin} (${c.name}): ${String(err.message || err).split('\n')[0]}`);
    } finally {
      await context.close();
    }
  }
  return { origin: null, tried };
}

async function openHome(browser, origin, initScript) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  await gotoPage(page, `${origin}/`);
  return { context, page };
}

/** The vault is what a returning user has: roomId plus the secret the server never saw. */
async function inviteLink(page, origin, roomId) {
  const raw = await page.evaluate(() => localStorage.getItem('poofspace.vault.v1'));
  if (!raw) throw new Error('the local vault is empty: no recovery entry was written');
  const entries = JSON.parse(raw);
  const list = Array.isArray(entries) ? entries : Object.values(entries ?? {});
  const hit = list.find((e) => e && e.roomId === roomId);
  if (!hit || !hit.secret) throw new Error(`no vault entry carrying a secret for ${roomId}`);
  return `${origin}/room/${roomId}#${hit.secret}`;
}

async function createRoom(page, origin) {
  await page.getByRole('button', { name: '创建聊天室' }).click();
  await page.waitForSelector('.room-id', { timeout: 30000 });
  const m = /\/room\/([a-z2-7]{26})/.exec(page.url());
  if (!m) throw new Error(`after creating, the url is ${page.url()} - no canonical room id`);
  const link = await inviteLink(page, origin, m[1]);
  return { roomId: m[1], link };
}

async function sendMessage(page, text) {
  await page.locator('.composer textarea').fill(text);
  await page.keyboard.press('Enter');
}

async function homeHasTwoEntries(browser, origin, emit) {
  const { context, page } = await openHome(browser, origin);
  try {
    const primary = (await page.locator('.btnrow .btn').allInnerTexts()).map((t) => t.trim());
    const accounts = await page.locator('a, button').filter({ hasText: /登录|注册|好友|设置中心|个人主页/ }).count();
    const ok = primary.length === 2 && primary.some((t) => t.includes('创建聊天室')) && primary.some((t) => t.includes('加入聊天室')) && accounts === 0;
    record('home two entries', ok ? 'PASS' : 'FAIL', `primary buttons ${JSON.stringify(primary)}; account affordances ${accounts}`);
    emit(`${ok ? 'PASS' : 'FAIL'} home exposes only create and join`);
  } finally {
    await context.close();
  }
}

/**
 * http://<LAN ip>:<port> is not a secure context, so window.crypto.subtle is undefined.
 * The room must still encrypt end to end: the tell is that the marker is visible in the
 * page but absent from every outgoing WebSocket frame, the SQLite file and the temp dir.
 */
async function insecureContextEncrypts(browser, origin, dataDir, emit) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const wire = [];
  page.on('websocket', (ws) => ws.on('frameSent', (f) => { if (f.opcode === 1) wire.push(String(f.payload)); }));
  try {
    await gotoPage(page, `${origin}/`);
    const caps = await page.evaluate(() => ({
      secure: window.isSecureContext,
      subtle: !!(window.crypto && window.crypto.subtle),
      rng: !!(window.crypto && window.crypto.getRandomValues)
    }));
    if (!caps.rng) {
      record('insecure context crypto', 'SKIP', 'this browser exposes no crypto.getRandomValues over http, so the fallback path cannot be reached');
      return;
    }
    if (caps.subtle) {
      record('insecure context crypto', 'SKIP', `${origin} still offers crypto.subtle (isSecureContext=${caps.secure}); the non-secure-context fallback was not exercised`);
      return;
    }
    const { roomId } = await createRoom(page, origin);
    const marker = `明文标记-${roomId.slice(0, 6)}-${Date.now()}`;
    await sendMessage(page, marker);
    await page.waitForSelector(`.bubble:has-text("${marker}")`, { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1200));

    const leakedFrames = wire.filter((f) => f.includes(marker));
    const needle = Buffer.from(marker, 'utf8');
    const leakedDb = fs.existsSync(path.join(dataDir, 'poofspace.sqlite')) && fs.readFileSync(path.join(dataDir, 'poofspace.sqlite')).includes(needle);
    let leakedFiles = false;
    const roomDir = path.join(dataDir, 'rooms', roomId);
    if (fs.existsSync(roomDir)) {
      const stack = [roomDir];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const full = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (fs.readFileSync(full).includes(needle)) leakedFiles = true;
        }
      }
    }
    const visible = (await page.locator('.bubble').innerText()).includes(marker);
    const ok = visible && leakedFrames.length === 0 && !leakedDb && !leakedFiles;
    record(
      'insecure context crypto',
      ok ? 'PASS' : 'FAIL',
      `subtle=${caps.subtle} secure=${caps.secure}; marker rendered=${visible}; plaintext in ${wire.length} outgoing frames: ${leakedFrames.length}; in sqlite: ${leakedDb}; in room temp files: ${leakedFiles}`
    );
    emit(`${ok ? 'PASS' : 'FAIL'} over http+ip the plaintext still never leaves the device`);
  } finally {
    await context.close();
  }
}

async function historyDecryptsForSecondDevice(browser, origin, emit) {
  const host = await openHome(browser, origin);
  let guest = null;
  try {
    const { roomId, link } = await createRoom(host.page, origin);
    const marker = `历史-${roomId.slice(0, 6)}-${Date.now()}`;
    await sendMessage(host.page, marker);
    await host.page.waitForSelector(`.bubble:has-text("${marker}")`, { timeout: 30000 });

    guest = await browser.newContext();
    const g = await guest.newPage();
    await gotoPage(g, link);
    await g.waitForSelector('.room-id', { timeout: 30000 });
    await g.waitForSelector(`.bubble:has-text("${marker}")`, { timeout: 30000 });
    const times = await g.locator(`.bubble:has-text("${marker}")`).count();
    const shown = compact(await g.locator('.room-id').innerText());
    const ok = times === 1 && shown.includes(roomId.slice(0, 6).replace(/\s/g, ''));
    record('history decrypts for a late joiner', ok ? 'PASS' : 'FAIL', `guest rendered the host message ${times} time(s); room shown ${shown}`);
    emit(`${ok ? 'PASS' : 'FAIL'} a second device decrypts the room history it never saw live`);
  } finally {
    if (guest) await guest.close();
    await host.context.close();
  }
}

/**
 * 正文 十一 功能「浏览器通知」。Three arms, because one number proves nothing:
 * granted + backgrounded must notify exactly once with no content in it; foregrounded must
 * stay silent; permission denied must stay silent AND must not break delivery. The negative
 * arms wait for the message to arrive before counting, so "no notification" can never be the
 * silent result of "the message never came".
 */
async function notificationsStayInsider(browser, origin, emit) {
  const host = await openHome(browser, origin);
  let guestCtx = null;
  try {
    const { roomId, link } = await createRoom(host.page, origin);
    guestCtx = await browser.newContext();
    await guestCtx.addInitScript(() => {
      window.__hidden = false;
      try {
        Object.defineProperty(document, 'hidden', { get: () => window.__hidden === true, configurable: true });
      } catch {
        /* a browser that freezes document.hidden still gets the other two arms */
      }
      window.__notifSpies = [];
      function SpyNotification(title, options) {
        const body = options && options.body != null ? String(options.body) : null;
        window.__notifSpies.push({ title: String(title), body });
        this.close = () => {};
      }
      SpyNotification.permission = 'granted';
      SpyNotification.requestPermission = async () => SpyNotification.permission;
      window.Notification = SpyNotification;
      window.__setNotifyPermission = (p) => {
        SpyNotification.permission = p;
      };
    });

    const g = await guestCtx.newPage();
    await gotoPage(g, link);
    await g.waitForSelector('.room-id', { timeout: 30000 });

    const spies = async () => g.evaluate(() => window.__notifSpies.map((s) => ({ title: s.title, body: s.body })));
    const setHidden = (hidden) => g.evaluate((h) => { window.__hidden = h; }, hidden);
    const arrived = (marker) => g.waitForSelector(`.bubble:has-text("${marker}")`, { timeout: 30000 });
    const appeared = async (n, ms) => {
      const deadline = Date.now() + ms;
      for (;;) {
        if ((await spies()).length >= n) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    // The notification surface must not carry anything the room does: not the body, not the
    // room id, and above all not a slice of the invite secret sitting in the hash.
    const secretHint = new URL(link).hash.slice(1, 9);
    const roomHint = roomId.slice(0, 6);
    await setHidden(true);
    const bg = `后台-${roomHint}-${Date.now()}`;
    await sendMessage(host.page, bg);
    const notified = await appeared(1, 10000);
    const shots = notified ? await spies() : [];
    const one = shots.length === 1;
    const payload = shots.length === 1 ? `${shots[0].title}${shots[0].body ?? ''}` : JSON.stringify(shots);
    const clean = one && ![bg, roomHint, secretHint].some((secret) => payload.includes(secret));

    await setHidden(false);
    const fg = `前台-${roomId.slice(0, 6)}-${Date.now()}`;
    await sendMessage(host.page, fg);
    await arrived(fg);
    const fgCount = (await spies()).length;

    await g.evaluate(() => window.__setNotifyPermission('denied'));
    await setHidden(true);
    const denied = `未授权-${roomId.slice(0, 6)}-${Date.now()}`;
    await sendMessage(host.page, denied);
    await arrived(denied);
    const deniedCount = (await spies()).length;

    const ok = notified && clean && fgCount === 1 && deniedCount === 1;
    record(
      'browser notification content',
      ok ? 'PASS' : 'FAIL',
      `backgrounded+granted notifications=${JSON.stringify(shots)} (expected exactly 1, message marker absent); foregrounded+granted total=${fgCount} (expected 1); backgrounded+denied total=${deniedCount} (expected 1) while all three bubbles rendered`
    );
    emit(`${ok ? 'PASS' : 'FAIL'} a backgrounded member is notified once, with no message content in it`);
  } finally {
    if (guestCtx) await guestCtx.close();
    await host.context.close();
  }
}

async function openLock(page) {
  await page.locator('.sec-btn').hover();
  await page.waitForSelector('.sec-tip', { state: 'visible', timeout: 5000 });
  return compact(await page.locator('.sec-tip').innerText());
}

/**
 * Same assurance, judged on the served bytes instead of a hydrated DOM: the tooltip text is part
 * of the first paint, so whatever the server writes into the HTML is something a user can be shown
 * before the browser has worked out which protocol it is on. Guessing "https" server-side shipped
 * that claim in plain-http HTML, and a DOM read that lands after hydration cannot see it at all -
 * which is exactly why the first version of this check kept passing while the failure came back
 * once out of nine lane runs.
 */
async function noTransportClaimInServedHtml(probeOrigin, emit) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let id = '';
  for (let i = 0; i < 26; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  // Fetched from the harness over the plain-http listener: this arm judges the bytes the server
  // writes, and "was this request TLS" is a property of that connection, not of the hostname the
  // browser was told to use. (The mapped insecure host resolves only inside chromium.)
  const res = await fetch(`${probeOrigin}/room/${id}`, { headers: { accept: 'text/html' } });
  const html = await res.text();
  const claims = compact(html).includes(compact(HTTPS_COPY));
  const conservative = compact(html).includes(compact(HTTP_COPY));
  const hasLock = html.includes('sec-tip');
  const ok = res.status === 200 && hasLock && !claims && conservative;
  record(
    'served html makes no transport assurance',
    ok ? 'PASS' : 'FAIL',
    `status=${res.status}; tooltip present in first paint=${hasLock}; https claim in served bytes=${claims}; http-warning copy present=${conservative}`
  );
  emit(`${ok ? 'PASS' : 'FAIL'} served html makes no transport assurance: claim=${claims} conservative=${conservative}`);
}

async function tooltipMode(browser, origin, expectHttps, name, emit) {
  const { context, page } = await openHome(browser, origin);
  try {
    await createRoom(page, origin);
    // Read the assurance before anyone interacts with it. The tooltip text sits in the DOM from
    // the first paint, so a page whose protocol the browser has not looked at yet must not state
    // one: this arm is what catches a server-rendered "this connection uses HTTPS" on plain http.
    const preTip = await page.locator('.sec-tip').first().innerText({ timeout: 20000 });
    const noClaimBeforeOpen = expectHttps ? true : !compact(preTip).includes(compact(HTTPS_COPY));
    const tip = await openLock(page);
    const secure = await page.evaluate(() => window.isSecureContext);
    const want = expectHttps ? HTTPS_COPY : HTTP_COPY;
    const other = expectHttps ? HTTP_COPY : HTTPS_COPY;
    const ok =
      tip.includes(compact(want)) &&
      !tip.includes(compact(other)) &&
      secure === expectHttps &&
      noClaimBeforeOpen;
    record(
      name,
      ok ? 'PASS' : 'FAIL',
      `isSecureContext=${secure}; tooltip ${ok ? 'matches the protocol' : `was "${tip}" on a page where secure=${secure}`}; before opening it the text claimed https=${!noClaimBeforeOpen}`
    );
    emit(`${ok ? 'PASS' : 'FAIL'} ${expectHttps ? 'https' : 'http'} tooltip makes no false assurance`);
  } finally {
    await context.close();
  }
}

/**
 * Acceptance item 9: with no CSPRNG the app must refuse rather than continue without
 * being able to encrypt. Only getRandomValues is taken away - replacing the whole
 * window.crypto also takes away randomUUID, which the page harness itself needs, and a
 * broken instrument tells you nothing about the product.
 */
async function rngAbsentBlocksSend(browser, origin, emit) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      Object.defineProperty(window.crypto, 'getRandomValues', { configurable: true, writable: true, value: undefined });
    } catch {
      /* not overridable in this build: the check reports SKIP */
    }
  });
  const page = await context.newPage();
  const errors = [];
  let crashed = false;
  let createRequests = 0;
  page.on('pageerror', (e) => errors.push(String(e.message || e).split('\n')[0].slice(0, 90)));
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/rooms') createRequests++;
  });
  page.on('crash', () => {
    crashed = true;
  });
  try {
    await gotoPage(page, `${origin}/`);
    const gone = await page.evaluate(() => typeof window.crypto?.getRandomValues !== 'function');
    if (!gone) {
      record('no rng no send', 'SKIP', 'crypto.getRandomValues could not be shadowed in this browser build, so the refusal path was not exercised');
      return;
    }
    const button = page.getByRole('button', { name: '创建聊天室' });
    if ((await button.count()) === 0) {
      record('no rng no send', 'FAIL', `the page rendered no create button at all once the rng was removed: url=${page.url()}, errors=${errors.join(' / ')}`);
      emit('FAIL without an rng the home page itself did not render');
      return;
    }
    // The button relabels itself while the click is in flight, so Playwright's actionability
    // wait can never settle. Dispatching the DOM click directly is the same event the user's
    // click produces, without the harness racing the re-render.
    //
    // But a click dispatched on an un-hydrated page does nothing at all, and that silence is
    // indistinguishable from a refusal. Opening the join dialog is the app's own witness that
    // its handlers are live; without it this leg can fail for a reason that is neither the
    // product's nor the rng's.
    await page.getByRole('button', { name: '加入聊天室' }).evaluate((el) => el.click());
    try {
      await page.waitForSelector('[role="dialog"]', { timeout: 10_000 });
    } catch {
      record('no rng no send', 'FAIL', `with the rng removed the home page never became interactive (the join dialog did not open within 10s): url=${page.url()}, errors=${errors.join(' / ')}`);
      emit('FAIL without an rng the home page never hydrated, so the refusal was never exercised');
      return;
    }
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5_000 }).catch(() => undefined);

    await button.evaluate((el) => el.click());
    await new Promise((r) => setTimeout(r, 3000));
    const url = page.url();
    // Judged on the error slot the app owns, not the page body: the hero copy says
    // 端到端加密 either way, so a body-wide regex was satisfied even with no error shown.
    const notice = page.locator('.notice-error');
    const noticeCount = await notice.count();
    const noticeText = noticeCount > 0 ? compact(await notice.first().innerText()) : '';
    const complained = noticeCount === 1 && /(随机数|密钥|CSPRNG|加密)/u.test(noticeText);
    const stayedOut = !/\/room\/[a-z2-7]{26}/.test(url);
    // A client that cannot produce key material must not even ask the server for a room:
    // a server-side room with no client key is the silent-degradation this check forbids.
    const refused = createRequests === 0;
    const ok = stayedOut && complained && refused && !crashed;
    record(
      'no rng no send',
      ok ? 'PASS' : 'FAIL',
      `renderer crashed=${crashed}; navigated to ${url.slice(0, 48)}; create requests=${createRequests}; notice count=${noticeCount}; notice text="${noticeText.slice(0, 70)}"; page errors=${errors.length} ${JSON.stringify(errors.slice(0, 2))}`
    );
    emit(`${ok ? 'PASS' : 'FAIL'} without an rng the app blocks the room instead of falling back to plaintext`);
  } finally {
    await context.close();
  }
}

/**
 * Virtual scrolling has to show in rendered geometry: with far more messages than fit the
 * viewport only a window of rows may exist, none zero-height and none stacked at the same
 * offset (two rows at one offset is how a broken key schedule looks on screen).
 */
async function virtualisedGeometry(browser, origin, emit) {
  const { context, page } = await openHome(browser, origin);
  try {
    const { roomId } = await createRoom(page, origin);
    const total = 120;
    for (let i = 0; i < total; i++) {
      await sendMessage(page, `滚动压力 ${i} ${'填充'.repeat(8)}`);
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 2500));
    const m = await page.evaluate(() => {
      const list = document.querySelector('.list');
      const sizer = document.querySelector('.sizer');
      const rows = [...document.querySelectorAll('.row')];
      const tops = rows.map((r) => Math.round(r.getBoundingClientRect().top));
      const dup = tops.filter((t, i) => tops.indexOf(t) !== i).length;
      const heights = rows.map((r) => r.getBoundingClientRect().height);
      return {
        viewport: list ? list.clientHeight : 0,
        sizerHeight: sizer ? Math.round(sizer.getBoundingClientRect().height) : 0,
        rendered: rows.length,
        bubbles: document.querySelectorAll('.bubble').length,
        zeroHeight: heights.filter((h) => h < 8).length,
        stackedRows: dup
      };
    });
    const windowed = m.rendered < total && m.sizerHeight > m.viewport * 1.5;
    const sane = m.zeroHeight === 0 && m.stackedRows === 0 && m.bubbles > 0;
    const ok = windowed && sane;
    record(
      `virtual list geometry (${roomId.slice(0, 6)})`,
      ok ? 'PASS' : 'FAIL',
      `sent ${total}: rendered rows ${m.rendered}, bubbles ${m.bubbles}, sizer ${m.sizerHeight}px vs viewport ${m.viewport}px, short rows ${m.zeroHeight}, stacked rows ${m.stackedRows}`
    );
    emit(`${ok ? 'PASS' : 'FAIL'} only a window of the ${total} messages is in the DOM`);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------- driver

/**
 * The home page states: "已销毁的房间会立即从本机移除". Judged on the rendered card list, on a
 * device that never pressed destroy itself.
 *
 * Two contexts, because one is not enough: the device that performed the destroy also throws away
 * its own secret, and its entry then disappears through the dead-credential branch - a leg reading
 * that card would stay green even with the online probe's removal deleted (which is exactly what
 * happened to the first version of this leg). Here A creates and destroys, while B is an ordinary
 * member whose only trace of the room is its own recovery entry and whose secret is still intact.
 * So the only code that can take B's card away is `verifyRoomAlive()` reading the server's one bit.
 */
async function recoveryEntryGoneAfterDestroy(browser, origin, emit) {
  const a = await openHome(browser, origin);
  const b = await browser.newContext({ ignoreHTTPSErrors: true });
  const bPage = await b.newPage();
  try {
    const { roomId, link } = await createRoom(a.page, origin);
    const rid = `#${roomId}`;
    const cardOf = () => bPage.locator('.vault-item').filter({ has: bPage.locator('.rid', { hasText: rid }) });

    // B enters through the invite link, which is what writes B's own recovery entry.
    await gotoPage(bPage, link);
    await bPage.waitForSelector('.composer textarea', { timeout: 30000 });
    await gotoPage(bPage, `${origin}/`);
    await bPage.waitForSelector('.vault-item', { timeout: 20000 });
    const before = await cardOf().count();

    // A destroys its own room through the dialog, then the server is asked to confirm.
    await a.page.getByRole('button', { name: '销毁' }).click();
    await a.page.locator('.modal .ack input[type=checkbox]').check();
    await a.page.locator('.modal button.btn-danger').click();
    const gone = await a.page.evaluate(async (id) => {
      for (let i = 0; i < 60; i++) {
        const res = await fetch(`/api/rooms/${id}/status`, { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (body && body.joinable === false) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    }, roomId);

    await gotoPage(bPage, `${origin}/`);
    let after = -1;
    let states = '';
    for (let i = 0; i < 60; i++) {
      await bPage.waitForSelector('.vault-item .when, .section', { timeout: 20000 }).catch(() => undefined);
      after = await cardOf().count();
      states = (await bPage.locator('.vault-item .when').allInnerTexts()).join('/').slice(0, 60);
      if (after === 0) break;
      await bPage.waitForTimeout(250);
    }
    const stillInVault = await bPage.evaluate((id) => {
      const raw = localStorage.getItem('poofspace.vault.v1');
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
      return list.some((e) => e && e.roomId === id);
    }, roomId);

    const ok = before === 1 && after === 0 && gone === true && stillInVault === false;
    record(
      'recovery entry disappears after destroy',
      ok ? 'PASS' : 'FAIL',
      `other device's card before=${before} after=${after}; server said not-joinable=${gone}; vault entry left=${stillInVault}; states=${states || 'none'}`
    );
    emit(`${ok ? 'PASS' : 'FAIL'} recovery entry disappears after destroy: before=${before} after=${after} notJoinable=${gone} vaultLeft=${stillInVault}`);
  } finally {
    await b.close();
    await a.context.close();
  }
}

export async function runBrowserLane({ quiet = false, headed = false, only = null } = {}) {
  const emit = (...lines) => {
    if (!quiet) process.stdout.write(lines.join('\n') + '\n');
  };
  const logs = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'poofspace-browser-'));
  const candidates = candidateAddresses();
  const playwright = loadPlaywright();

  if (!fs.existsSync(path.join(root, 'dist', 'server', 'server.js'))) {
    record('lane prerequisites', 'SKIP', 'dist/server/server.js is missing; run npm run build first');
    return { status: 'SKIP', results, exitCode: 1 };
  }
  if (!playwright) {
    record('lane prerequisites', 'SKIP', 'neither playwright-core nor playwright resolves from the project or the user profile: no browser was launched, so none of items 7/9/10 is verified');
    return { status: 'SKIP', results, exitCode: 1 };
  }
  if (!candidates.length) {
    record('lane prerequisites', 'SKIP', 'no non-internal IPv4 address: http://IP:port is a secure context on loopback, so the insecure case cannot be reproduced');
    return { status: 'SKIP', results, exitCode: 1 };
  }

  const httpPort = await freePort();
  const httpsPort = await freePort();
  const httpProbe = `http://127.0.0.1:${httpPort}`;
  const httpsOrigin = `https://127.0.0.1:${httpsPort}`;
  const baseEnv = { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', PUBLIC_BASE_URL: '', TRUST_PROXY: '' };
  delete baseEnv.TLS_KEY_FILE;
  delete baseEnv.TLS_CERT_FILE;

  const httpSrv = bootServer({ ...baseEnv, HOST: '0.0.0.0', PORT: String(httpPort), DATA_DIR: path.join(work, 'data-http') }, logs);
  let httpsSrv = null;
  try {
    const cert = makeCert(work, [...candidates.map((c) => c.address), '127.0.0.1']);
    httpsSrv = bootServer(
      { ...baseEnv, HOST: '0.0.0.0', PORT: String(httpsPort), DATA_DIR: path.join(work, 'data-https'), TLS_KEY_FILE: cert.key, TLS_CERT_FILE: cert.crt },
      logs
    );
    await waitHealth(httpsOrigin);
  } catch (err) {
    if (httpsSrv) await httpsSrv.stop();
    httpsSrv = null;
    record('https lock tooltip', 'SKIP', `no TLS listener (openssl missing or the cert was refused): ${err.message}`);
  }

  let browser = null;
  try {
    const exe = findChromium();
    if (!exe) {
      record('lane execution', 'SKIP', 'no chromium build in any ms-playwright cache and POOFSPACE_CHROME is unset; nothing was rendered, so items 7/9/10 stay unverified');
    } else {
      emit(`launching ${exe}`);
      // --no-proxy-server: chromium would otherwise honour the Windows system proxy, which
      // cannot always reach a LAN address this machine is itself listening on.
      browser = await playwright.pw.chromium.launch({
        headless: !headed,
        executablePath: exe,
        args: ['--no-sandbox', '--no-proxy-server', `--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`]
      });
      await waitHealth(httpProbe);
      let httpOrigin = `http://${INSECURE_HOST}:${httpPort}`;
      const mapped = await loadsAsInsecureContext(browser, httpOrigin);
      if (!mapped.ok) {
        const probe = await pickInsecureOrigin(browser, httpPort, candidates);
        if (!probe.origin) {
          record(
            'insecure origin reachability',
            'SKIP',
            `neither the mapped host nor any local address gave the browser a plain-http, non-secure-context page; the insecure-context checks (items 7/9/10 over http) did not run. ${mapped.detail} | ${probe.tried.join(' | ').slice(0, 400)}`
          );
          httpOrigin = null;
        } else {
          httpOrigin = probe.origin;
        }
      }
      if (httpOrigin) {
        emit(`browser lane: ${playwright.from}, http=${httpOrigin}${httpsSrv ? `, https=${httpsOrigin}` : ''}`);
        // One check throwing must not hide the verdicts of the others: each is run on its
        // own, and a thrown error is recorded as a FAIL for that check only.
        const checks = [
          ['home two entries', () => homeHasTwoEntries(browser, httpOrigin, emit)],
          ['insecure context crypto', () => insecureContextEncrypts(browser, httpOrigin, path.join(work, 'data-http'), emit)],
          ['history decrypts for a late joiner', () => historyDecryptsForSecondDevice(browser, httpOrigin, emit)],
          ['recovery entry disappears after destroy', () => recoveryEntryGoneAfterDestroy(browser, httpOrigin, emit)],
          ['http lock tooltip', () => tooltipMode(browser, httpOrigin, false, 'http lock tooltip', emit)],
          ['served html makes no transport assurance', () => noTransportClaimInServedHtml(httpProbe, emit)],
          ['no rng no send', () => rngAbsentBlocksSend(browser, httpOrigin, emit)],
          ['browser notification content', () => notificationsStayInsider(browser, httpOrigin, emit)],
          ['virtual list geometry', () => virtualisedGeometry(browser, httpOrigin, emit)]
        ];
        if (httpsSrv) checks.push(['https lock tooltip', () => tooltipMode(browser, httpsOrigin, true, 'https lock tooltip', emit)]);
        // `--only` is for proving one leg's teeth without paying for the whole lane. It must
        // never be readable as a lane verdict, so a filtered run records a SKIP for the rest.
        const enabled = only ? checks.filter(([label]) => label.includes(only)) : checks;
        if (only) {
          record(
            'lane scope',
            'SKIP',
            `--only "${only}" ran ${enabled.length} of ${checks.length} leg(s): ${enabled.map(([l]) => l).join(', ') || 'none'}; the legs it skipped are not verified by this invocation`
          );
        }
        for (const [label, run] of enabled) {
          try {
            await run();
          } catch (err) {
            const why = String((err && err.message) || err).split('\n')[0].slice(0, 260);
            record(label, 'FAIL', `the check threw before reaching a verdict: ${why}`);
            emit(`FAIL ${label}: threw ${why}`);
          }
        }
      }
    }
  } catch (err) {
    const tail = logs.join('').split('\n').filter(Boolean).slice(-8).join(' | ');
    record('lane execution', 'FAIL', `${err && err.message ? err.message : String(err)}; server tail: ${tail.slice(0, 400)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await httpSrv.stop();
    if (httpsSrv) await httpsSrv.stop();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  for (const r of results) emit(`${r.status.padEnd(4)} ${r.name}: ${r.detail}`);
  const status = failed.length ? 'FAIL' : skipped.length ? 'SKIP' : 'PASS';
  return { status, results, exitCode: status === 'PASS' ? 0 : 1 };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] ?? '' : null;
  const lane = await runBrowserLane({ quiet: argv.includes('--quiet'), headed: argv.includes('--headed'), only });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(lane, null, 2) + '\n');
  process.exit(lane.exitCode);
}
