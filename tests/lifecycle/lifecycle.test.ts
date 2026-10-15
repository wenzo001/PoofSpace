import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { appendText, join, makeSandbox, seedRoom } from '../helpers/sandbox';
import { sealChunk } from '../../src/lib/crypto/envelope';
import { randomBytes, randomHex, utf8 } from '../../src/lib/encoding';
import { ERR, LIMITS } from '../../src/lib/constants';

async function withAttachment(sbx: ReturnType<typeof makeSandbox>, room: ReturnType<typeof seedRoom>, who: { slot: number; gen: number; sessionToken: string }) {
  const attachmentId = randomHex(16);
  const payload = utf8('附件正文-should-vanish');
  const meta = { name: 'x.bin', mime: 'application/octet-stream', size: payload.length, chunkSize: 1024, chunkCount: 1, kind: 'file' as const };
  const created = sbx.service.createAttachment({
    roomId: room.roomId,
    slot: who.slot,
    gen: who.gen,
    attachmentId,
    chunkSize: meta.chunkSize,
    chunkCount: meta.chunkCount,
    totalBytes: meta.size,
    meta: utf8('opaque-meta-blob'),
    metaNonce: randomBytes(12),
    kind: 'file'
  });
  if (!created.ok) throw new Error('attachment create failed');
  const frame = await sealChunk(room.keys.fileKey, { slot: who.slot, gen: who.gen }, 1, room.roomId, attachmentId, 0, payload);
  const written = await sbx.service.writeChunk(room.roomId, attachmentId, 0, frame, who.sessionToken);
  if (!written.ok) throw new Error('chunk write failed');
  const complete = sbx.service.completeAttachment(room.roomId, attachmentId, who.sessionToken);
  if (!complete.ok) throw new Error('attachment complete failed');
  return attachmentId;
}

function historyCount(sbx: { db: { raw: import('better-sqlite3').Database } }, roomId: string): number {
  return (sbx.db.raw.prepare('SELECT COUNT(*) c FROM messages WHERE room_id=?').get(roomId) as { c: number }).c;
}

describe('creator-initiated destroy', () => {
  it('clears database rows, attachment files and memory, and proves it', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const ref = { n: 0 };
      await appendText(sbx, room, who, '销毁前的话', ref);
      await appendText(sbx, room, who, '还有这一句', ref);
      const attachmentId = await withAttachment(sbx, room, who);
      const dir = path.join(sbx.cfg.roomsDir, room.roomId);
      expect(fs.existsSync(path.join(dir, attachmentId, '0.bin'))).toBe(true);

      const res = await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);
      expect(res.ok).toBe(true);
      const report = res.report!;
      expect(report.verifiedEmpty).toBe(true);
      expect(report.files).toBeGreaterThan(0);
      expect(report.rows.messages).toBe(2);
      expect(report.rows.attachments).toBe(1);
      expect(report.rows.chunks).toBe(1);
      expect(report.rows.slots).toBeGreaterThan(0);
      expect(report.rows.tokens).toBeGreaterThan(0);

      expect(fs.existsSync(dir)).toBe(false);
      expect((sbx.db.raw.prepare('SELECT COUNT(*) c FROM messages WHERE room_id=?').get(room.roomId) as { c: number }).c).toBe(0);
      expect((sbx.db.raw.prepare('SELECT COUNT(*) c FROM attachments WHERE room_id=?').get(room.roomId) as { c: number }).c).toBe(0);
      expect((sbx.db.raw.prepare('SELECT COUNT(*) c FROM attachment_chunks').get() as { c: number }).c).toBe(0);
      expect((sbx.db.raw.prepare('SELECT COUNT(*) c FROM slots WHERE room_id=?').get(room.roomId) as { c: number }).c).toBe(0);
      expect((sbx.db.raw.prepare('SELECT COUNT(*) c FROM session_tokens WHERE room_id=?').get(room.roomId) as { c: number }).c).toBe(0);
      // A destroyed room leaves no row behind at all: no tombstone, no id-to-creator mapping,
      // nothing that could be revived by a request, a refresh or a restart.
      expect(sbx.db.raw.prepare('SELECT COUNT(*) c FROM rooms WHERE id=?').get(room.roomId)).toMatchObject({ c: 0 });
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
      expect(sbx.service.stats().roomsActive).toBe(0);
    } finally {
      sbx.close();
    }
  });

  it('kills every old credential: rejoin, append, download and token all refused', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const attachmentId = await withAttachment(sbx, room, who);
      const staleSession = who.sessionToken;
      const ref = { n: 0 };
      const dto = await appendText(sbx, room, who, '稍后要消失的话', ref);

      await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);

      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
      // Old invite cannot re-enter.
      const proofBad = sbx.service.join({ roomId: room.roomId, proof: randomBytes(32), nick: utf8('x'), nickNonce: randomBytes(12) }, randomBytes(32));
      expect(proofBad.ok).toBe(false);
      // Old session token cannot download.
      expect(sbx.service.authorizeToken(staleSession, room.roomId)).toBeNull();
      expect(sbx.service.attachmentIndex(room.roomId, attachmentId)).toBeNull();
      // Old writer cannot append, and appending does not resurrect the room.
      const late = await sbx.service.appendMessage({
        roomId: room.roomId,
        slot: who.slot,
        gen: who.gen,
        clientMsgId: randomHex(16),
        kind: 'text',
        nonce: randomBytes(12),
        ct: randomBytes(40)
      });
      expect(late.ok).toBe(false);
      expect([ERR.roomDestroyed, ERR.notMember, ERR.roomNotFound]).toContain(late.code);
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
      expect((sbx.db.raw.prepare('SELECT COUNT(*) c FROM messages WHERE room_id=?').get(room.roomId) as { c: number }).c).toBe(0);
      expect(sbx.service.messageDto(room.roomId, dto!.seq)).toBeNull();
      // An old upload task cannot land a chunk either.
      const orphan = await sbx.service.writeChunk(room.roomId, attachmentId, 1, randomBytes(64), staleSession);
      expect(orphan.ok).toBe(false);
    } finally {
      sbx.close();
    }
  });

  it('is idempotent under concurrent destroy requests', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      await appendText(sbx, room, who, '并发销毁前的话', { n: 0 });
      const results = await Promise.all(
        Array.from({ length: 6 }, () => sbx.service.destroy(room.roomId, 'creator', room.creatorToken))
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
      expect(fs.existsSync(path.join(sbx.cfg.roomsDir, room.roomId))).toBe(false);
      expect(sbx.service.destroyReports.get(room.roomId)?.verifiedEmpty).toBe(true);
    } finally {
      sbx.close();
    }
  });

  it('cannot be reactivated by an in-flight writer racing the destroy', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      // Race a burst of appends against destroy: no interleaving may leave rows behind.
      const writes = Array.from({ length: 40 }, (_, i) =>
        sbx.service.appendMessage({
          roomId: room.roomId,
          slot: who.slot,
          gen: who.gen,
          clientMsgId: `race-${i}`,
          kind: 'text',
          nonce: randomBytes(12),
          ct: randomBytes(32)
        })
      );
      const destroy = sbx.service.destroy(room.roomId, 'creator', room.creatorToken);
      await Promise.all([...writes, destroy]);
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
      expect((sbx.db.raw.prepare('SELECT COUNT(*) c FROM messages WHERE room_id=?').get(room.roomId) as { c: number }).c).toBe(0);
      expect(fs.existsSync(path.join(sbx.cfg.roomsDir, room.roomId))).toBe(false);
    } finally {
      sbx.close();
    }
  });
});

describe('idle grace after the last member leaves', () => {
  it('holds the room through the window, and a rejoin inside it cancels the countdown', async () => {
    const sbx = makeSandbox({ roomIdleTtlMs: 5_000 });
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      const b = join(sbx, room, '乙', 1);
      await appendText(sbx, room, a, '窗口内要留下来的话', { n: 0 });
      expect(sbx.service.status(room.roomId).online).toBe(2);

      sbx.service.leave(room.roomId, a.slot);
      sbx.service.leave(room.roomId, b.slot);
      expect(sbx.service.status(room.roomId).online).toBe(0);
      expect(sbx.service.status(room.roomId).status).toBe('IDLE_GRACE');

      const t0 = Date.now();
      // One tick just after the leave: the window has not elapsed, and nothing was deleted.
      sbx.service.tick(t0 + 1_000);
      await new Promise((r) => setTimeout(r, 60));
      expect(sbx.service.status(room.roomId).status).toBe('IDLE_GRACE');
      expect(historyCount(sbx, room.roomId)).toBe(1);

      // A member returns inside the window -> the same room is handed back, ACTIVE again.
      const back = join(sbx, room, '甲回归', 2);
      expect(sbx.service.status(room.roomId).status).toBe('ACTIVE');
      sbx.service.tick(t0 + 4_000);
      expect(sbx.service.status(room.roomId).status).toBe('ACTIVE');
      sbx.service.leave(room.roomId, back.slot);

      sbx.service.tick(Date.now() + 6_000);
      await new Promise((r) => setTimeout(r, 80));
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
    } finally {
      sbx.close();
    }
  });

  it('ships a 300 second recovery window by default', () => {
    const sbx = makeSandbox();
    try {
      expect(LIMITS.roomIdleTtlSeconds).toBe(300);
      expect(sbx.cfg.roomIdleTtlMs).toBe(300_000);
    } finally {
      sbx.close();
    }
  });

  it('drops a member whose heartbeat went silent, then applies the same window', async () => {
    const sbx = makeSandbox({ roomIdleTtlMs: 3_000, heartbeatGraceMs: 2_000 });
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const t0 = Date.now();
      sbx.service.tick(t0 + 5_000);
      expect(sbx.service.status(room.roomId).online).toBe(0);
      expect(sbx.service.status(room.roomId).status).toBe('IDLE_GRACE');
      sbx.service.tick(t0 + 9_000);
      await new Promise((r) => setTimeout(r, 80));
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
      void who;
    } finally {
      sbx.close();
    }
  });

  it('does not destroy a room that still has a live member', async () => {
    // The heartbeat grace must genuinely outlast the jump, or the member is reaped first and
    // this leg would be measuring a room that went empty, not one that was occupied.
    const sbx = makeSandbox({ roomIdleTtlMs: 1_000, heartbeatGraceMs: 120_000 });
    try {
      const room = seedRoom(sbx);
      join(sbx, room, '常驻者');
      const later = Date.now() + 60_000;
      const swept = sbx.service.tick(later);
      await new Promise((r) => setTimeout(r, 60));
      expect(swept.dropped).toBe(0);
      expect(sbx.service.status(room.roomId).online).toBe(1);
      expect(sbx.service.status(room.roomId).status).toBe('ACTIVE');
    } finally {
      sbx.close();
    }
  });
});

describe('restart and recovery', () => {
  it('finishes an interrupted destroy and never revives a destroyed room', async () => {
    const sbx = makeSandbox();
    const dataDir = sbx.dataDir;
    const roomsDir = sbx.cfg.roomsDir;
    const dbFile = sbx.cfg.dbFile;
    let destroyedId = '';
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      await appendText(sbx, room, who, '重启前消息', { n: 0 });
      await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);
      destroyedId = room.roomId;

      // Simulate a crash between "marked DESTROYING" and "row deleted": the room is not in the
      // ledger any more (destroy removes its own row), so re-plant it as the crashed node left it.
      sbx.db.raw
        .prepare(
          `INSERT INTO rooms (id,status,join_key,creator_token,max_members,next_slot,head_seq,created_at,updated_at,destroy_reason)
           VALUES (?,'DESTROYING',?,?,100,2,1,?,?, 'creator')`
        )
        .run(destroyedId, Buffer.alloc(32), Buffer.alloc(32), Date.now(), Date.now());
      sbx.db.raw.prepare('INSERT INTO messages (room_id,seq,client_msg_id,sender_slot,nonce,ct,kind,created_at) VALUES (?,99,?,1,?,?,?,?)').run(
        destroyedId,
        'leftover',
        randomBytes(12),
        randomBytes(32),
        'text',
        Date.now()
      );
      fs.mkdirSync(path.join(roomsDir, destroyedId, 'crashatt'), { recursive: true });
      fs.writeFileSync(path.join(roomsDir, destroyedId, 'crashatt', '0.bin'), 'leftover bytes');
    } finally {
      sbx.close(true);
    }

    // Reopen the same data directory: recovery must finish the job.
    const reopened = makeSandboxReopen(dataDir, dbFile, roomsDir);
    try {
      const row = reopened.db.raw.prepare('SELECT status FROM rooms WHERE id=?').all(destroyedId) as { status: string }[];
      expect(row.map((r) => r.status)).toEqual(['DESTROYING']);
      const rec = await reopened.service.recoverOnStartup();
      expect(rec.finishing.length).toBe(1);
      // Finished means gone: not a DESTROYED tombstone, but no row for that room at all.
      expect(reopened.db.raw.prepare('SELECT COUNT(*) c FROM rooms').get()).toMatchObject({ c: 0 });
      expect((reopened.db.raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(0);
      const survivors = await reopened.storage.listRoomDirs();
      expect(survivors).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it('puts surviving rooms into the recovery window and clears sessions', async () => {
    const sbx = makeSandbox();
    const dataDir = sbx.dataDir;
    const roomsDir = sbx.cfg.roomsDir;
    const dbFile = sbx.cfg.dbFile;
    let roomId = '';
    try {
      const room = seedRoom(sbx);
      roomId = room.roomId;
      const who = join(sbx, room);
      await appendText(sbx, room, who, '重启后仍然在', { n: 0 });
      expect(sbx.service.status(roomId).online).toBe(1);
    } finally {
      sbx.close(true);
    }
    const reopened = makeSandboxReopen(dataDir, dbFile, roomsDir);
    try {
      const rec = await reopened.service.recoverOnStartup();
      expect(rec.active).toContain(roomId);
      expect(reopened.db.raw.prepare('SELECT COUNT(*) c FROM session_tokens').get()).toMatchObject({ c: 0 });
      expect(reopened.db.raw.prepare('SELECT COUNT(*) c FROM slots WHERE connected=1').get()).toMatchObject({ c: 0 });
      // No WebSocket survived, so the room is empty — and empty is the grace window, not a
      // deletion. The history is still there for whoever holds the invite.
      expect(reopened.service.status(roomId).status).toBe('IDLE_GRACE');
      expect(historyCount(reopened, roomId)).toBe(1);
      reopened.service.tick(Date.now() + 300_001);
      await new Promise((r) => setTimeout(r, 80));
      expect(reopened.service.status(roomId).status).toBe('UNKNOWN');
    } finally {
      reopened.close();
    }
  });

  it('prunes attachment directories that have no live room behind them', async () => {
    const sbx = makeSandbox();
    try {
      fs.mkdirSync(path.join(sbx.cfg.roomsDir, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'orphan'), { recursive: true });
      fs.writeFileSync(path.join(sbx.cfg.roomsDir, 'aaaaaaaaaaaaaaaaaaaaaaaaaa', 'orphan', '0.bin'), 'x');
      const rec = await sbx.service.recoverOnStartup();
      expect(rec.active).toEqual([]);
      expect(await sbx.storage.listRoomDirs()).toEqual([]);
    } finally {
      sbx.close();
    }
  });
});

describe('background task hygiene', () => {
  it('expires a stalled upload and removes its partial chunks', async () => {
    const sbx = makeSandbox({ pendingUploadTtlMs: 50 });
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const attachmentId = randomHex(16);
      const created = sbx.service.createAttachment({
        roomId: room.roomId,
        slot: who.slot,
        gen: who.gen,
        attachmentId,
        chunkSize: 1024,
        chunkCount: 2,
        totalBytes: 100,
        meta: utf8('m'),
        metaNonce: randomBytes(12),
        kind: 'file'
      });
      expect(created.ok).toBe(true);
      await sbx.service.writeChunk(room.roomId, attachmentId, 0, randomBytes(64), who.sessionToken);
      const file = path.join(sbx.cfg.roomsDir, room.roomId, attachmentId, '0.bin');
      expect(fs.existsSync(file)).toBe(true);

      await new Promise((r) => setTimeout(r, 90));
      const n = sbx.service.sweepExpiredAttachments();
      expect(n).toBe(1);
      await new Promise((r) => setTimeout(r, 80));
      expect(fs.existsSync(file)).toBe(false);
      expect(sbx.service.attachmentIndex(room.roomId, attachmentId)).toBeNull();
      const roomRow = sbx.db.raw.prepare('SELECT attachment_bytes FROM rooms WHERE id=?').get(room.roomId) as { attachment_bytes: number };
      // The expired upload takes its reservation with it: the quota is back to zero.
      expect(roomRow.attachment_bytes).toBe(0);
    } finally {
      sbx.close();
    }
  });

  it('caps the retained history per room so queues cannot grow without bound', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const rows = LIMITS.messagesPerRoomHard;
      expect(rows).toBeGreaterThan(0);
      // Inserting beyond the cap must be refused rather than silently accepted.
      sbx.db.raw.prepare('UPDATE rooms SET head_seq=? WHERE id=?').run(LIMITS.messagesPerRoomHard, room.roomId);
      const res = await sbx.service.appendMessage({
        roomId: room.roomId,
        slot: who.slot,
        gen: who.gen,
        clientMsgId: 'over-cap',
        kind: 'text',
        nonce: randomBytes(12),
        ct: randomBytes(32)
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(ERR.storageFull);
    } finally {
      sbx.close();
    }
  });

  it('leaves no room record to expire later — there is no retention ledger at all', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);
      // The row is deleted by the destroy itself. A sweep that "purges old tombstones" would
      // only exist if the node kept a directory of rooms it had already killed.
      expect((sbx.db.raw.prepare('SELECT COUNT(*) c FROM rooms').get() as { c: number }).c).toBe(0);
      expect('retentionPurge' in sbx.service).toBe(false);
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
    } finally {
      sbx.close();
    }
  });
});

// Reopen an existing data directory with the same config shape.
import { Db } from '../../src/server/db';
import { RoomStorage } from '../../src/server/storage';
import { RoomService } from '../../src/server/service';
import { loadConfig } from '../../src/server/config';

function makeSandboxReopen(dataDir: string, dbFile: string, roomsDir: string) {
  const cfg = {
    ...loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' } as NodeJS.ProcessEnv),
    env: 'test' as const,
    dataDir,
    dbFile,
    roomsDir
  };
  const db = new Db(dbFile);
  const storage = new RoomStorage(roomsDir);
  const service = new RoomService(db, storage, cfg);
  return {
    db,
    storage,
    service,
    cfg,
    close: () => {
      service.stop();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}
