#!/usr/bin/env node
/**
 * PoofSpace health check CLI.
 *
 *   node scripts/healthcheck.mjs                     # http://127.0.0.1:3000/api/health
 *   node scripts/healthcheck.mjs --port 8080
 *   node scripts/healthcheck.mjs --tls --host 192.168.1.20
 *   node scripts/healthcheck.mjs --url https://poof.example/api/health
 *
 * Exit codes: 0 = healthy, 1 = unhealthy/unreachable, 2 = bad usage.
 * Only counters are printed: never keys, tokens, room ids, headers or env values.
 */
import http from 'node:http';
import https from 'node:https';

const HELP = `Usage: node scripts/healthcheck.mjs [options]

  --url <url>        Full health endpoint (default: derived from host/port/tls).
  --host <host>      Host to probe (default: HOST env; 0.0.0.0 is probed as 127.0.0.1).
  --port <port>      Port to probe (default: PORT env, else 3000).
  --tls              Use https (default: on when TLS_KEY_FILE and TLS_CERT_FILE are set).
  --insecure         Accept self-signed certificates (testing only).
  --timeout <ms>     Per-attempt request timeout (default 5000).
  --retries <n>      Extra attempts before failing (default 0).
  --interval <ms>    Wait between attempts (default 1000).
  --quiet            Print nothing but the failure reason.
  -h, --help         Show this help.
`;

function parseArgs(argv) {
  const opts = { url: null, host: null, port: null, tls: null, insecure: false, timeout: 5000, retries: 0, interval: 1000, quiet: false };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) fail(`--${name} needs a positive number, got ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        process.exit(0);
        break;
      case '--url':
        opts.url = argv[++i];
        break;
      case '--host':
        opts.host = argv[++i];
        break;
      case '--port':
        opts.port = num(argv[++i], 'port');
        break;
      case '--tls':
        opts.tls = true;
        break;
      case '--no-tls':
        opts.tls = false;
        break;
      case '--insecure':
        opts.insecure = true;
        break;
      case '--timeout':
        opts.timeout = num(argv[++i], 'timeout');
        break;
      case '--retries':
        opts.retries = Number(argv[++i]) || 0;
        break;
      case '--interval':
        opts.interval = num(argv[++i], 'interval');
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      default:
        fail(`unknown option ${a}`);
    }
  }
  return opts;
}

function fail(msg) {
  process.stderr.write(`healthcheck: ${msg}\n`);
  process.exit(2);
}

function defaultUrl(opts) {
  const env = process.env;
  const hostRaw = opts.host ?? env.HOST ?? '127.0.0.1';
  const host = hostRaw === '0.0.0.0' || hostRaw === '::' || hostRaw === '*' ? '127.0.0.1' : hostRaw;
  const port = opts.port ?? Number(env.PORT || 3000);
  const tls = opts.tls ?? !!(env.TLS_KEY_FILE && env.TLS_CERT_FILE);
  return `${tls ? 'https' : 'http'}://${host}:${port}/api/health`;
}

function get(url, { timeout, insecure }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`malformed url: ${url}`));
      return;
    }
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.get(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        timeout,
        rejectUnauthorized: insecure ? false : undefined,
        headers: { accept: 'application/json', 'user-agent': 'poofspace-healthcheck' }
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 64 * 1024) {
            res.destroy();
            reject(new Error('health payload too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timed out after ${timeout}ms`));
    });
    req.on('error', reject);
  });
}

/** Shape check only; the payload is deliberately free of secrets *and* of room counts. */
function inspect(payload) {
  const problems = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return ['body is not a JSON object'];
  if (payload.ok !== true) problems.push(`ok is ${JSON.stringify(payload.ok)}, expected true`);
  if (typeof payload.proto !== 'number') problems.push('proto is not a number');
  for (const leak of ['rooms', 'wsConnections', 'online', 'messages', 'attachments']) {
    if (leak in payload) problems.push(`health payload carries ${leak}; the public listener must answer liveness only`);
  }
  return problems;
}

const opts = parseArgs(process.argv.slice(2));
const url = opts.url ?? defaultUrl(opts);
const log = (...a) => {
  if (!opts.quiet) process.stdout.write(...a);
};

let lastError = 'no attempt made';
for (let attempt = 0; attempt <= opts.retries; attempt++) {
  try {
    const res = await get(url, { timeout: opts.timeout, insecure: opts.insecure });
    if (res.status !== 200) {
      lastError = `HTTP ${res.status} from ${url}`;
    } else {
      let body;
      try {
        body = JSON.parse(res.body);
      } catch {
        lastError = 'response is not JSON';
        body = null;
      }
      if (body) {
        const problems = inspect(body);
        if (problems.length) {
          lastError = problems.join('; ');
        } else {
          process.stdout.write(`healthcheck PASS ${url} proto=${body.proto}\n`);
          process.exit(0);
        }
      }
    }
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
  }
  if (attempt < opts.retries) await new Promise((r) => setTimeout(r, opts.interval));
}

process.stderr.write(`healthcheck FAIL ${url}: ${lastError}\n`);
process.exit(1);
