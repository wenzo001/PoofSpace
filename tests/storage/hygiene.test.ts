import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendText, join, makeSandbox, seedRoom } from '../helpers/sandbox';
import { captureLogs } from '../../src/server/log';
import { encodeRoomId } from '../../src/lib/crypto/invite';
import { bytesToB64 } from '../../src/lib/encoding';
import { randomBytes, randomHex, utf8 } from '../../src/lib/encoding';
import { sealChunk } from '../../src/lib/crypto/envelope';

/**
 * "Temporary storage" is only a claim if the residue is provably gone. These legs walk the
 * controlled storage — the SQLite file plus its WAL and SHM, the attachment tree, the operator
 * log stream — looking for bytes that must not survive a destroy or a purge, rather than
 * trusting that a `DELETE` statement ran.
 */

type Sbx = ReturnType<typeof makeSandbox>;

function fileWalk(root: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) out.push(...fileWalk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

/** Every byte of every controlled file, searched for a needle that should have been erased. */
function findBytes(root: string, needle: Uint8Array): string[] {
  const hits: string[] = [];
  const buf = Buffer.from(needle);
  for (const f of fileWalk(root)) {
    try {
      if (fs.readFileSync(f).includes(buf)) hits.push(path.relative(root, f));
    } catch {
      /* a file that vanished mid-scan is not residue we can point at */
    }
  }
  return hits;
}

const count = (sbx: Sbx, table: string) => (sbx.db.raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

async function withAttachment(
  sbx: Sbx,
  room: ReturnType<typeof seedRoom>,
  who: { slot: number; gen: number; sessionToken: string },
  body: string
): Promise<{ attachmentId: string; frame: Uint8Array }> {
  const attachmentId = randomHex(16);
  const payload = utf8(body);
  const created = sbx.service.createAttachment({
    roomId: room.roomId,
    slot: who.slot,
    gen: who.gen,
    attachmentId,
    chunkSize: 1024,
    chunkCount: 1,
    totalBytes: payload.length,
    meta: utf8('opaque-meta-blob'),
    metaNonce: randomBytes(12),
    kind: 'file'
  });
  if (!created.ok) throw new Error('attachment create failed');
  const frame = await sealChunk(room.keys.fileKey, { slot: who.slot, gen: who.gen }, 1, room.roomId, attachmentId, 0, payload);
  const written = await sbx.service.writeChunk(room.roomId, attachmentId, 0, frame, who.sessionToken);
  if (!written.ok) throw new Error('chunk write failed');
  const done = sbx.service.completeAttachment(room.roomId, attachmentId, who.sessionToken);
  if (!done.ok) throw new Error('attachment complete failed');
  return { attachmentId, frame };
}

describe('temporary storage, and the residue a DELETE leaves behind', () => {
  it('1. keeps ciphertext available during the recovery window and nothing readable anywhere', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const message = '窗口期内仍然只有密文';
      const dto = await appendText(sbx, room, who, message, { n: 0 });
      const att = await withAttachment(sbx, room, who, '附件正文-should-vanish');
      sbx.service.leave(room.roomId, who.slot, who.gen);
      expect(sbx.service.status(room.roomId).status).toBe('IDLE_GRACE');

      // Still there, because the window has not run out.
      expect(count(sbx, 'messages')).toBe(1);
      expect(fs.existsSync(path.join(sbx.cfg.roomsDir, room.roomId, att.attachmentId, '0.bin'))).toBe(true);
      // And still only ever ciphertext: the plaintext marker appears in no controlled file.
      const hits = findBytes(sbx.dataDir, utf8(message));
      expect(hits).toEqual([]);
      const attHits = findBytes(sbx.cfg.roomsDir, utf8('附件正文-should-vanish'));
      expect(attHits).toEqual([]);
      const ct = Buffer.from(dto!.ct, 'base64');
      expect(findBytes(sbx.dataDir, ct)).not.toEqual([]);
    } finally {
      sbx.close();
    }
  });

  it('2. the log stream never carries a room id, a secret, a link fragment or plaintext', async () => {
    const sbx = makeSandbox();
    let lines: string[] = [];
    let room: ReturnType<typeof seedRoom> | null = null;
    let secondRoomId = '';
    try {
      room = seedRoom(sbx);
      const who = join(sbx, room, '日志');
      lines = await captureLogs(async () => {
        await appendText(sbx, room!, who, '日志里不该出现的一句话', { n: 0 });
        sbx.service.leave(room!.roomId, who.slot, who.gen);
        sbx.service.tick(Date.now() + 301_000);
        await new Promise((r) => setTimeout(r, 120));
        await sbx.service.destroy(room!.roomId, 'creator', room!.creatorToken);

        // The branch that reports a failure is the one most likely to print a path, and a path
        // through the attachment root carries the room id in it.
        const stuck = seedRoom(sbx);
        const stuckMember = join(sbx, stuck, '卡住的');
        const storage = sbx.storage as unknown as { removeRoom: (id: string) => Promise<{ files: number; bytes: number }> };
        const realRemove = storage.removeRoom.bind(storage);
        storage.removeRoom = async () => {
          throw Object.assign(new Error(`EBUSY: resource busy or locked, rm '${path.join(sbx.cfg.roomsDir, stuck.roomId)}'`), {
            code: 'EBUSY'
          });
        };
        await sbx.service.destroy(stuck.roomId, 'creator', stuck.creatorToken);
        sbx.service.tick(Date.now() + 60_000);
        await new Promise((r) => setTimeout(r, 80));
        storage.removeRoom = realRemove;
        secondRoomId = stuck.roomId;
      });
    } finally {
      sbx.close();
    }
    const blob = lines.join('\n');
    expect(blob.length).toBeGreaterThan(0);
    expect(blob).not.toContain('日志里不该出现的一句话');
    expect(blob).not.toContain(room!.roomId);
    expect(blob).not.toContain(secondRoomId);
    expect(blob).not.toContain(bytesToB64(room!.secret));
    expect(blob).not.toContain('#');
    expect(blob).not.toContain(room!.creatorToken);
  });

  it('3. a destroyed room leaves no database record of any kind', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      await appendText(sbx, room, who, '要一起消失的话', { n: 0 });
      await withAttachment(sbx, room, who, '附件正文-should-vanish');
      const before = count(sbx, 'messages');
      expect(before).toBeGreaterThan(0);

      const res = await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);
      expect(res.report?.verifiedEmpty).toBe(true);
      for (const t of ['rooms', 'messages', 'attachments', 'attachment_chunks', 'slots', 'session_tokens']) {
        expect(count(sbx, t), t).toBe(0);
      }
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
    } finally {
      sbx.close();
    }
  });

  it('4. cleanup reaches the attachment directory, the partial chunks and the .tmp files', async () => {
    const sbx = makeSandbox({ vacuumFreelistPages: 1 });
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const att = await withAttachment(sbx, room, who, '附件正文-should-vanish');
      // A half-written chunk leaves a .tmp beside the finished one; it is controlled storage too.
      const stray = path.join(sbx.cfg.roomsDir, room.roomId, att.attachmentId, '1.bin.99999.tmp');
      fs.writeFileSync(stray, 'unfinished');
      const dto = await appendText(sbx, room, who, '销毁后要扫不到', { n: 0 });
      const ct = Buffer.from(dto!.ct, 'base64');
      const roomDir = path.join(sbx.cfg.roomsDir, room.roomId);
      expect(fs.existsSync(roomDir)).toBe(true);

      await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);

      expect(fs.existsSync(roomDir)).toBe(false);
      expect(fs.existsSync(stray)).toBe(false);
      expect(count(sbx, 'attachment_chunks')).toBe(0);
      // Beyond the row: after checkpoint + VACUUM the ciphertext bytes are not sitting in a free
      // page of the database file either, and the WAL was truncated rather than left to age.
      expect(findBytes(sbx.dataDir, ct)).toEqual([]);
    } finally {
      sbx.close();
    }
  });

  it('4b. the ephemeral database is opened with the erasure pragmas it claims', () => {
    const sbx = makeSandbox();
    try {
      // `secure_delete` is what zeroes freed pages as they are released, and WAL is what the
      // residue would otherwise hide in until a checkpoint truncates it. Both are per-connection
      // settings, so this is the only place the claim can be checked for the shipped connection.
      expect(Number(sbx.db.raw.pragma('secure_delete', { simple: true }))).toBe(1);
      expect(String(sbx.db.raw.pragma('journal_mode', { simple: true }))).toBe('wal');
      expect(Number(sbx.db.raw.pragma('foreign_keys', { simple: true }))).toBe(1);
      expect(Number(sbx.db.raw.pragma('busy_timeout', { simple: true }))).toBeGreaterThanOrEqual(5000);
    } finally {
      sbx.close();
    }
  });

  it('5. no old credential, link, download or upload task can reach the destroyed room', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const att = await withAttachment(sbx, room, who, '附件正文-should-vanish');
      const token = who.sessionToken;
      await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);

      expect(sbx.service.authorizeToken(token, room.roomId)).toBeNull();
      expect(sbx.service.attachmentIndex(room.roomId, att.attachmentId)).toBeNull();
      expect(sbx.service.history(room.roomId).msgs).toEqual([]);
      const lateWrite = await sbx.service.writeChunk(room.roomId, att.attachmentId, 0, randomBytes(64), token);
      expect(lateWrite.ok).toBe(false);
      const lateComplete = sbx.service.completeAttachment(room.roomId, att.attachmentId, token);
      expect(lateComplete.ok).toBe(false);
      const lateJoin = sbx.service.join(
        { roomId: room.roomId, proof: randomBytes(32), nick: utf8('x'), nickNonce: randomBytes(12) },
        randomBytes(32)
      );
      expect(lateJoin.ok).toBe(false);
    } finally {
      sbx.close();
    }
  });

  it('6. the schema and the data directory carry no room directory, audit table or backup', () => {
    const sbx = makeSandbox();
    try {
      const tables = (
        sbx.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
      ).map((r) => r.name);
      // Both directions: nothing extra may grow in there, and the runtime tables stay named.
      expect([...tables].sort()).toEqual(
        [
          'attachment_chunks',
          'attachments',
          'messages',
          'meta',
          'rooms',
          'session_tokens',
          'slots'
        ].sort()
      );
      expect(tables.some((t) => /audit|history_log|room_index|backup|telemetry/i.test(t))).toBe(false);
    } finally {
      sbx.close(true);
    }
    // And on disk: only the ephemeral database, its WAL/SHM and the attachment root.
    const allowed = /^poofspace\.sqlite(-wal|-shm)?$/;
    const extras = fs
      .readdirSync(sbx.dataDir)
      .filter((e) => e !== 'rooms' && e !== 'admin-control.json' && !allowed.test(e));
    expect(extras).toEqual([]);
  });

  it('7. after a full purge no room and no restore path is left', async () => {
    const sbx = makeSandbox();
    try {
      const a = seedRoom(sbx);
      const b = seedRoom(sbx);
      const aWho = join(sbx, a, '甲');
      const bWho = join(sbx, b, '乙');
      const dto = await appendText(sbx, a, aWho, '清理后要扫不到', { n: 0 });
      await withAttachment(sbx, b, bWho, '另一个附件正文');
      const ct = Buffer.from(dto!.ct, 'base64');

      const summary = await sbx.service.purgeAll();
      expect(summary.ok).toBe(true);
      expect(summary.rooms).toBe(2);
      for (const t of ['rooms', 'messages', 'attachments', 'attachment_chunks', 'slots', 'session_tokens']) {
        expect(count(sbx, t), t).toBe(0);
      }
      expect(await sbx.storage.countAll()).toBe(0);
      expect(findBytes(sbx.dataDir, ct)).toEqual([]);
      expect(sbx.service.isPaused()).toBe(false);
      // Old sessions are worthless and a new room still works: the node came back, not stayed down.
      expect(sbx.service.authorizeToken(aWho.sessionToken, a.roomId)).toBeNull();
      const fresh = seedRoom(sbx);
      expect(sbx.service.slotsHeld()).toBe(1);
      join(sbx, fresh, '新用户');
      expect(sbx.service.status(fresh.roomId).status).toBe('ACTIVE');
    } finally {
      sbx.close();
    }
  });

  it('8. a purge that cannot prove itself stays in maintenance instead of claiming clean', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room, '甲');
      await appendText(sbx, room, who, '清理失败时的话', { n: 0 });
      const storage = sbx.storage as unknown as { removeRoom: (id: string) => Promise<{ files: number; bytes: number }> };
      storage.removeRoom = async () => {
        throw new Error('simulated EBUSY');
      };

      const summary = await sbx.service.purgeAll();

      expect(summary.ok).toBe(false);
      expect(sbx.service.isPaused()).toBe(true);
      expect(sbx.service.pendingDestroys().length).toBe(1);
      // A node left in maintenance refuses new rooms rather than quietly accepting more work.
      expect(() => seedRoom(sbx)).toThrow(/MAINTENANCE/);
      // The rows are gone because wiping them *is* the command's job, but the unfinished
      // directory is still on the retry ledger: the purge reports the debt instead of a clean slate.
      expect(sbx.service.slotsHeld()).toBe(0);
      expect(sbx.service.pendingDestroys().length).toBe(1);
      expect(summary.unfinished).toBe(1);
    } finally {
      sbx.close();
    }
  });

  it('9. a schema-v1 database migrates in place, and an emptied room becomes IDLE_GRACE', async () => {
    const { Db } = await import('../../src/server/db');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poof-migrate-'));
    const file = path.join(dataDir, 'poofspace.sqlite');
    const secret = randomBytes(32);
    const now = Date.now();
    const liveId = encodeRoomId(randomBytes(16));
    const activeId = encodeRoomId(randomBytes(16));
    try {
      const downgraded = new Db(file);
      try {
        // Re-create the v1 shape by hand: no IDLE_GRACE in the CHECK, same columns, same order.
        downgraded.raw.exec(`
          PRAGMA foreign_keys = OFF;
          CREATE TABLE rooms_v1 (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('ACTIVE','DESTROYING','DESTROYED')),
            join_key BLOB NOT NULL, creator_token BLOB NOT NULL,
            max_members INTEGER NOT NULL, next_slot INTEGER NOT NULL DEFAULT 1,
            head_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            empty_since INTEGER, destroy_reason TEXT, destroyed_at INTEGER,
            attachment_bytes INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO rooms_v1 SELECT id,status,join_key,creator_token,max_members,next_slot,head_seq,created_at,updated_at,empty_since,destroy_reason,destroyed_at,attachment_bytes FROM rooms;
          DROP TABLE rooms;
          ALTER TABLE rooms_v1 RENAME TO rooms;
          UPDATE meta SET value='1' WHERE key='schema_version';
        `);
        const insert = downgraded.raw.prepare(
          `INSERT INTO rooms (id,status,join_key,creator_token,max_members,next_slot,head_seq,created_at,updated_at,empty_since)
           VALUES (?,'ACTIVE',?,?,100,?,?,?,?,?)`
        );
        // One room already emptied under v1 (empty_since set), one still holding a member.
        insert.run(liveId, secret, secret, 3, 2, now, now, now - 60_000);
        insert.run(activeId, secret, secret, 2, 0, now, now, null);
        downgraded.raw
          .prepare('INSERT INTO messages (room_id,seq,client_msg_id,sender_slot,nonce,ct,kind,created_at) VALUES (?,1,?,1,?,?,?,?)')
          .run(liveId, 'v1-message', randomBytes(12), Buffer.from('迁移后要还在的一段密文'), 'text', now);
      } finally {
        downgraded.close();
      }

      const reopened = new Db(file);
      try {
        // Pinned to a literal on purpose: v1 now walks the whole chain, so reaching 3 is part of
        // what this proves. Reading SCHEMA_VERSION here would let any version pass.
        expect((reopened.raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe('3');
        const rows = reopened.raw.prepare('SELECT id, status FROM rooms ORDER BY id').all() as { id: string; status: string }[];
        // The room that had already emptied under v1 is recognised as being in the recovery window;
        // the one that still had people stays ACTIVE. Neither is deleted: a redeploy may not wipe
        // data that is still valid.
        expect(rows.find((r) => r.id === liveId)?.status).toBe('IDLE_GRACE');
        expect(rows.find((r) => r.id === activeId)?.status).toBe('ACTIVE');
        expect((reopened.raw.prepare('SELECT COUNT(*) c FROM messages WHERE room_id=?').get(liveId) as { c: number }).c).toBe(1);
        // The rebuilt CHECK is what makes the new state writable at all, and the children still
        // point at the surviving table.
        reopened.raw.prepare("UPDATE rooms SET status='IDLE_GRACE' WHERE id=?").run(activeId);
        expect(reopened.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    }
  });

  it('10. a destroy that leaves the files behind is retried, not reported as done', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const dto = await appendText(sbx, room, who, '重试前要留下的话', { n: 0 });
      const ct = Buffer.from(dto!.ct, 'base64');
      const storage = sbx.storage as unknown as { removeRoom: (id: string) => Promise<{ files: number; bytes: number }> };
      const realRemove = storage.removeRoom.bind(sbx.storage);
      storage.removeRoom = async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      };
      const first = await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);
      expect(first.report?.verifiedEmpty).toBe(false);
      expect(first.report?.status).toBe('DESTROYING');
      // The ciphertext is still there — and so is the row: the room has not been declared destroyed.
      expect(findBytes(sbx.dataDir, ct)).not.toEqual([]);
      expect(sbx.service.status(room.roomId).status).toBe('DESTROYING');
      expect(sbx.service.slotsHeld()).toBe(1);

      storage.removeRoom = realRemove;
      sbx.service.tick(Date.now() + sbx.cfg.destroyRetryMs + 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
      expect(findBytes(sbx.dataDir, ct)).toEqual([]);
      expect(sbx.service.pendingDestroys()).toEqual([]);
    } finally {
      sbx.close();
    }
  });
});
