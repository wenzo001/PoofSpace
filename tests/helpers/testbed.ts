import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { LIMITS } from '../../src/lib/constants';
import { createServer, type RunningServer } from '../../src/server/server';
import { RoomClient, type RoomClientOptions, type WsLike } from '../../src/lib/client/roomclient';
import type { ClientMessage } from '../../src/lib/client/roomclient';
import { b64ToBytes } from '../../src/lib/encoding';
import { parseInviteInput } from '../../src/lib/crypto/invite';

export interface Testbed {
  srv: RunningServer;
  base: string;
  dataDir: string;
  roomsDir: string;
  dbFile: string;
  restart(): Promise<Testbed>;
  cleanup(): Promise<void>;
}

let seq = 0;

export async function makeTestbed(
  overrides: Partial<RunningServer['cfg']> = {}
): Promise<Testbed> {
  const id = `${process.pid}-${Date.now()}-${seq++}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `poof-test-${id}-`));
  const cfg: Partial<RunningServer['cfg']> = {
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbFile: path.join(dataDir, 'poofspace.sqlite'),
    roomsDir: path.join(dataDir, 'rooms'),
    roomIdleTtlMs: LIMITS.roomIdleTtlSeconds * 1000,
    heartbeatServerMs: 15_000,
    // Keep this paired with LIMITS.heartbeatGraceMs in src/lib/constants.ts: a lane that runs a
    // tighter grace than production would measure the fixture, not the shipped behaviour.
    heartbeatGraceMs: 60_000,
    logLevel: 'error',
    ...overrides
  };
  const srv = await createServer(cfg);
  const base = `http://127.0.0.1:${srv.port}`;

  const self: Testbed = {
    srv,
    base,
    dataDir,
    roomsDir: cfg.roomsDir as string,
    dbFile: cfg.dbFile as string,
    restart: async () => {
      const port = srv.port;
      await srv.close();
      const next = await createServer({ ...cfg, port, dataDir, dbFile: cfg.dbFile, roomsDir: cfg.roomsDir } as Partial<RunningServer['cfg']>);
      self.srv = next;
      return self;
    },
    cleanup: async () => {
      try {
        await self.srv.close();
      } catch {
        /* already closed by a restart test */
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
  return self;
}

export function openSocket(url: string): WsLike {
  const ws = new WebSocket(url);
  return ws as unknown as WsLike;
}

export function clientOptions(tb: Testbed, extra: Partial<RoomClientOptions> = {}): RoomClientOptions {
  return { base: tb.base, openSocket, ackTimeoutMs: 20_000, ...extra };
}

export async function newRoom(tb: Testbed, nick = '创建者', maxMembers = 100): Promise<RoomClient> {
  const client = await RoomClient.createRoom(clientOptions(tb, { maxMembers }), nick);
  await client.connect();
  return client;
}

export async function joinByInvite(tb: Testbed, invite: { code: string }, nick: string): Promise<RoomClient> {
  const parsed = parseInviteInput(invite.code);
  if (!parsed) throw new Error('invite could not be parsed');
  const client = RoomClient.fromSecret(clientOptions(tb), parsed, nick);
  await client.connect();
  return client;
}

export async function joinByLink(tb: Testbed, link: string, nick: string): Promise<RoomClient> {
  const parsed = parseInviteInput(link);
  if (!parsed) throw new Error('link could not be parsed');
  const client = RoomClient.fromSecret(clientOptions(tb), parsed, nick);
  await client.connect();
  return client;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 15_000, intervalMs = 25, label = 'condition' } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await predicate();
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Collects the next `n` messages observed by a client without racing the arrival. */
export function recorder(client: RoomClient): { all: () => ClientMessage[]; text: (body: string) => ClientMessage | undefined } {
  const seen: ClientMessage[] = [];
  client.on((e) => {
    if (e.type === 'message') {
      if (!seen.some((m) => m.clientMsgId === e.msg.clientMsgId)) seen.push(e.msg);
    }
  });
  return {
    all: () => seen.slice(),
    text: (body) => seen.find((m) => m.text === body)
  };
}

/** Walks every byte of a controlled storage area looking for plaintext markers. */
export function scanForPlaintext(root: string, needles: string[]): { file: string; needle: string }[] {
  const hits: { file: string; needle: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = fs.readFileSync(full);
      for (const needle of needles) {
        if (bytes.includes(needle)) hits.push({ file: path.relative(root, full), needle });
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return hits;
}

export function decodeB64(s: string): Uint8Array {
  return b64ToBytes(s);
}

export function makeBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

export function sliceProvider(data: Uint8Array) {
  return async (start: number, length: number): Promise<Uint8Array> => data.slice(start, start + length);
}
