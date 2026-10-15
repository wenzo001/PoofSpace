import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../../src/server/db';
import { RoomStorage } from '../../src/server/storage';
import { RoomService } from '../../src/server/service';
import { loadConfig, type AppConfig } from '../../src/server/config';
import { deriveRoomKeys, computeJoinProof } from '../../src/lib/crypto/keys';
import { encodeRoomId } from '../../src/lib/crypto/invite';
import { sealMessage } from '../../src/lib/crypto/envelope';
import { randomBytes, randomHex, bytesToB64url } from '../../src/lib/encoding';
import type { MessageDto } from '../../src/lib/proto';

let counter = 0;

export interface Sandbox {
  db: Db;
  storage: RoomStorage;
  service: RoomService;
  cfg: AppConfig;
  dataDir: string;
  close(keepData?: boolean): void;
}

/** Direct service-layer harness: exercises the state machine without HTTP noise. */
export function makeSandbox(overrides: Partial<AppConfig> = {}): Sandbox {
  const id = `${process.pid}-${Date.now()}-${counter++}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `poof-sbx-${id}-`));
  const cfg: AppConfig = {
    ...loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' } as NodeJS.ProcessEnv),
    env: 'test',
    dataDir,
    dbFile: path.join(dataDir, 'poofspace.sqlite'),
    roomsDir: path.join(dataDir, 'rooms'),
    ...overrides
  };
  fs.mkdirSync(cfg.roomsDir, { recursive: true });
  const db = new Db(cfg.dbFile);
  const storage = new RoomStorage(cfg.roomsDir);
  const service = new RoomService(db, storage, cfg);
  return {
    db,
    storage,
    service,
    cfg,
    dataDir,
    close: (keepData = false) => {
      service.stop();
      db.close();
      if (!keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

export interface SeededRoom {
  roomId: string;
  secret: Uint8Array;
  creatorToken: string;
  keys: ReturnType<typeof deriveRoomKeys>;
  challenge: Uint8Array;
}

export function seedRoom(sbx: Sandbox, maxMembers = 100): SeededRoom {
  const secret = randomBytes(32);
  const roomId = encodeRoomId(randomBytes(16));
  const keys = deriveRoomKeys(secret);
  const created = sbx.service.createRoom(roomId, keys.joinKey, maxMembers);
  if (!created.ok) throw new Error(`seed create refused: ${created.code}`);
  return { roomId, secret, creatorToken: created.creatorToken, keys, challenge: randomBytes(32) };
}

/** Joins and returns the (slot, gen) pair so tests can drive the service directly. */
export function join(sbx: Sandbox, room: SeededRoom, nick = '测试者', nonceOffset = 0) {
  const challenge = room.challenge.slice();
  challenge[0] = (challenge[0] as number) + nonceOffset;
  const proof = computeJoinProof(room.keys.joinKey, room.roomId, challenge);
  const sealed = { nick: new Uint8Array([1]), nickNonce: new Uint8Array(12) };
  const res = sbx.service.join(
    { roomId: room.roomId, proof, nick: sealed.nick, nickNonce: sealed.nickNonce },
    challenge
  );
  if (!res.ok) throw new Error(`join failed: ${res.code}`);
  return { slot: res.slot as number, gen: res.gen as number, sessionToken: res.sessionToken as string };
}

export async function appendText(
  sbx: Sandbox,
  room: SeededRoom,
  who: { slot: number; gen: number },
  body: string,
  counterRef: { n: number }
): Promise<MessageDto | undefined> {
  const clientMsgId = bytesToB64url(randomBytes(16));
  const sealed = await sealMessage(
    room.keys.msgKey,
    { slot: who.slot, gen: who.gen },
    ++counterRef.n,
    room.roomId,
    clientMsgId,
    { kind: 'text', body }
  );
  const res = sbx.service.appendMessage({
    roomId: room.roomId,
    slot: who.slot,
    gen: who.gen,
    clientMsgId,
    kind: 'text',
    nonce: sealed.nonce,
    ct: sealed.ct
  });
  if (!res.ok) throw new Error(`append failed: ${res.code}`);
  return sbx.service.messageDto(room.roomId, res.seq as number) ?? undefined;
}

export function readAllBlobs(db: Db): { hex: string; table: string }[] {
  const out: { hex: string; table: string }[] = [];
  const dump = (sql: string, table: string) => {
    for (const row of db.raw.prepare(sql).all() as Record<string, unknown>[]) {
      for (const [k, v] of Object.entries(row)) {
        if (Buffer.isBuffer(v)) out.push({ hex: v.toString('hex'), table: `${table}.${k}` });
        else if (typeof v === 'string') out.push({ hex: Buffer.from(v, 'utf8').toString('hex'), table: `${table}.${k}` });
      }
    }
  };
  dump('SELECT * FROM messages', 'messages');
  dump('SELECT * FROM attachments', 'attachments');
  dump('SELECT * FROM rooms', 'rooms');
  dump('SELECT * FROM slots', 'slots');
  return out;
}

export function blobContains(entry: { hex: string }, needle: string): boolean {
  return entry.hex.includes(Buffer.from(needle, 'utf8').toString('hex'));
}
