import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { createServer, resolveOrigin, securityHeaders, type RunningServer } from '../../src/server/server';
import { loadConfig } from '../../src/server/config';
import { randomBytes, bytesToB64url } from '../../src/lib/encoding';
import { encodeRoomId, newSecretBytes } from '../../src/lib/crypto/invite';
import { deriveRoomKeys } from '../../src/lib/crypto/keys';

/**
 * Proves the IP + HTTPS deployment mode against a private CA — how a LAN install actually
 * gets a certificate the client trusts — and that transport-security headers appear only on
 * a connection that really is encrypted. A leaf certificate is useless as its own trust
 * anchor in Node, so the chain is CA + leaf with the IP in the leaf's SAN.
 */

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const openssl = hasOpenssl();
const dir = openssl ? fs.mkdtempSync(path.join(os.tmpdir(), 'poof-tls-')) : '';
const caCert = path.join(dir, 'ca.pem');
const caKey = path.join(dir, 'ca-key.pem');
const leafCert = path.join(dir, 'leaf.pem');
const leafKey = path.join(dir, 'leaf-key.pem');
const leafExt = path.join(dir, 'leaf.ext');
const leafCsr = path.join(dir, 'leaf.csr');

let tlsSrv: RunningServer | null = null;
let plainSrv: RunningServer | null = null;

function makeChain(ip: string): void {
  const leafCfg = [
    '[ poofleaf ]',
    `subjectAltName=IP:${ip}`,
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'authorityKeyIdentifier=keyid,issuer',
    ''
  ].join('\n');
  fs.writeFileSync(leafExt, leafCfg);
  // The CA's extensions must come from a config section. OpenSSL 1.1.1's `-addext` produced
  // a CA that Node would not build a chain against, which shows up as a failing assertion
  // about the product's TLS listener instead of a broken fixture.
  const caCfg = [
    '[ req ]',
    'distinguished_name = dn',
    'x509_extensions = v3_ca',
    'prompt = no',
    '[ dn ]',
    'CN = PoofSpace Test CA',
    '[ v3_ca ]',
    'basicConstraints = critical,CA:TRUE,pathlen:0',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
    ''
  ].join('\n');
  const caCnf = path.join(dir, 'ca.cnf');
  fs.writeFileSync(caCnf, caCfg);
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCert, '-days', '2', '-config', caCnf]);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', leafKey, '-out', leafCsr, '-subj', `/CN=${ip}`]);
  run(['x509', '-req', '-in', leafCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', leafCert, '-days', '2', '-extfile', leafExt, '-extensions', 'poofleaf']);
  // Prove the fixture itself before blaming the product: an untrusted chain would otherwise
  // read as "the server cannot do TLS".
  execFileSync('openssl', ['verify', '-CAfile', caCert, leafCert], { stdio: 'ignore' });
}

function run(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'ignore' });
}

function get(port: number, p: string, opts: https.RequestOptions): Promise<{ status: number; headers: NodeJS.Dict<string | string[]>; body: string; peerCert?: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: p, ...opts }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        // getPeerCertificate(true) returns the detailed form, whose SAN key is lowercased.
        const peer = (res.socket as unknown as { getPeerCertificate?: (d: boolean) => Record<string, unknown> } | null)?.getPeerCertificate?.(true);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          peerCert: peer
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port: number, p: string, payload: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method: 'POST',
        ca: [fs.readFileSync(caCert)],
        headers: { origin: `https://127.0.0.1:${port}`, 'content-type': 'application/json' }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

beforeAll(async () => {
  if (!openssl) return;
  makeChain('127.0.0.1');
  const base = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' } as unknown as NodeJS.ProcessEnv);
  const boot = async (tls: { keyFile: string; certFile: string } | null): Promise<RunningServer> => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poof-tls-data-'));
    return createServer({
      ...base,
      env: 'test',
      host: '127.0.0.1',
      port: 0,
      dataDir,
      dbFile: path.join(dataDir, 'poofspace.sqlite'),
      roomsDir: path.join(dataDir, 'rooms'),
      tls,
      logLevel: 'error'
    });
  };
  tlsSrv = await boot({ keyFile: leafKey, certFile: leafCert });
  plainSrv = await boot(null);
});

afterAll(async () => {
  await tlsSrv?.close();
  await plainSrv?.close();
  if (openssl) fs.rmSync(dir, { recursive: true, force: true });
});

describe.runIf(openssl)('HTTPS listener (IP + certificate carrying that IP)', () => {
  it('serves health over TLS verified against the issuing CA, and the leaf names the IP', async () => {
    const res = await get(tlsSrv!.port, '/api/health', { ca: [fs.readFileSync(caCert)] });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    // The gate is that the leaf the server presented is actually valid for that IP, which is
    // how a LAN install has to be provisioned; Node's SAN spelling varies with the OpenSSL build.
    // Read the presented chain on a bare TLS socket: this server answers with no-store, so the
    // response socket can already be detached once the body has drained.
    const cert = await openPeerCert(tlsSrv!.port);
    expect(String(cert.subjectaltname)).toContain('127.0.0.1');
    expect(tls.checkServerIdentity('127.0.0.1', cert)).toBeUndefined();
  });

  it('refuses a client that does not trust the issuing CA', async () => {
    await expect(get(tlsSrv!.port, '/api/health', { ca: [] })).rejects.toThrow(/verify|certificate/i);
  });

  it('claims transport security only on the encrypted listener', async () => {
    const secure = await get(tlsSrv!.port, '/api/health', { ca: [fs.readFileSync(caCert)] });
    expect(String(secure.headers['strict-transport-security'])).toContain('max-age=');
    expect(String(secure.headers['content-security-policy'])).toContain("default-src");
    expect(securityHeaders(plainSrv!.cfg, false)['strict-transport-security']).toBe('');
    expect(securityHeaders(tlsSrv!.cfg, true)['strict-transport-security']).toContain('includeSubDomains');
  });

  it('keeps the bearer invite secret out of the referrer chain and out of frames', () => {
    for (const cfg of [tlsSrv!.cfg, plainSrv!.cfg]) {
      for (const secure of [true, false]) {
        const h = securityHeaders(cfg, secure);
        expect(h['referrer-policy']).toBe('no-referrer');
        expect(h['x-frame-options']).toBe('DENY');
      }
    }
  });

  // App Router ships its flight payload in inline <script> blocks. A policy that refuses
  // them renders a page that looks fine and does nothing, so the allowance is checked here
  // instead of discovered in a browser months later.
  it('allows the inline bootstrap scripts the page needs to hydrate', () => {
    for (const cfg of [tlsSrv!.cfg, plainSrv!.cfg]) {
      for (const secure of [true, false]) {
        const csp = String(securityHeaders(cfg, secure)['content-security-policy']);
        const src = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
        expect(src).toContain("'self'");
        expect(src).toContain("'unsafe-inline'");
        expect(csp).not.toContain('unsafe-eval');
      }
    }
  });

  // 'unsafe-eval' is React's development-time stack machinery, nothing more. The exemption has to
  // be reachable exactly one way (NODE_ENV=development, set by scripts/dev.mjs) and must never be
  // the string a deployment ships - an unset NODE_ENV counts as shipped.
  it('confines the dev eval exemption to the development policy', () => {
    const dev = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).csp;
    const prod = loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).csp;
    const unset = loadConfig({} as NodeJS.ProcessEnv).csp;
    expect(dev).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(prod).not.toContain('unsafe-eval');
    expect(unset).not.toContain('unsafe-eval');
    expect(prod).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('names no third-party origin any script could be fetched from', () => {
    const allowed = new Set(["'self'", "'unsafe-inline'", "'none'", 'ws:', 'wss:', 'blob:', 'data:']);
    for (const secure of [true, false]) {
      const csp = String(securityHeaders(tlsSrv!.cfg, secure)['content-security-policy']);
      for (const directive of ['default-src', 'script-src', 'style-src', 'connect-src', 'worker-src', 'img-src']) {
        const sources = (new RegExp(`${directive}([^;]*)`).exec(csp)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
        expect(sources.length).toBeGreaterThan(0);
        for (const token of sources) expect(allowed.has(token)).toBeTruthy();
      }
    }
  });

  // upgrade-insecure-requests on a plain http listener makes the browser fetch every
  // chunk over https from a port that only speaks http: the room dies with a blank list.
  it('does not tell an http page to upgrade its own subresources', () => {
    const plain = securityHeaders(plainSrv!.cfg, false)['content-security-policy'];
    const secure = securityHeaders(tlsSrv!.cfg, true)['content-security-policy'];
    expect(plain).not.toContain('upgrade-insecure-requests');
    expect(secure).toContain('upgrade-insecure-requests');
  });

  it('creates a room over TLS and a wss upgrade reaches the join handshake', async () => {
    // The room id and the invite secret are minted client-side; the server only ever sees
    // the id and the join-key digest, over TLS here.
    const secret = newSecretBytes();
    const body = JSON.stringify({
      roomId: encodeRoomId(randomBytes(16)),
      joinKey: bytesToB64url(deriveRoomKeys(secret).joinKey)
    });
    const created = await post(tlsSrv!.port, '/api/rooms', body);
    expect(created.status).toBe(201);
    expect((JSON.parse(created.body) as { roomId?: string }).roomId).toBeTruthy();

    const frame = await wssHello(tlsSrv!.port);
    expect(frame.t).toBe('hello');
    expect(Buffer.from(String(frame.serverNonce), 'base64').length).toBe(32);
  });
});

describe.runIf(openssl)('origin resolution and proxy trust', () => {
  it('prefers PUBLIC_BASE_URL over anything the client sent', () => {
    const cfg = { ...tlsSrv!.cfg, publicBaseUrl: 'https://poof.example', trustProxy: true };
    expect(resolveOrigin(fakeReq({ host: `127.0.0.1:${tlsSrv!.port}` }), cfg)).toBe('https://poof.example');
  });

  it('ignores X-Forwarded-* unless a proxy is explicitly trusted', () => {
    const headers = { host: `127.0.0.1:${plainSrv!.port}`, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.example' };
    const base = { ...plainSrv!.cfg, publicBaseUrl: null };
    expect(resolveOrigin(fakeReq(headers), { ...base, trustProxy: false })).toBe(`http://127.0.0.1:${plainSrv!.port}`);
    expect(resolveOrigin(fakeReq(headers), { ...base, trustProxy: true })).toBe('https://attacker.example');
  });

  it('derives the scheme from the socket when there is no proxy', () => {
    const cfg = { ...tlsSrv!.cfg, publicBaseUrl: null, trustProxy: false };
    expect(resolveOrigin(fakeReq({ host: '192.168.1.10:3000' }, true), cfg)).toBe('https://192.168.1.10:3000');
    expect(resolveOrigin(fakeReq({ host: '192.168.1.10:3000' }, false), cfg)).toBe('http://192.168.1.10:3000');
  });
});

function fakeReq(headers: Record<string, string>, encrypted = false): IncomingMessage {
  return { headers, socket: { encrypted } } as unknown as IncomingMessage;
}

function openPeerCert(port: number): Promise<import('node:tls').PeerCertificate> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, ca: [fs.readFileSync(caCert)] }, () => {
      const cert = s.getPeerCertificate(true) as unknown as import('node:tls').PeerCertificate;
      s.destroy();
      resolve(cert);
    });
    s.on('error', reject);
  });
}

function wssHello(port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
      ca: [fs.readFileSync(caCert)],
      headers: { origin: `https://127.0.0.1:${port}` }
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('wss handshake timed out'));
    }, 5000);
    ws.on('message', (raw) => {
      clearTimeout(timer);
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      ws.close();
      resolve(frame);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
