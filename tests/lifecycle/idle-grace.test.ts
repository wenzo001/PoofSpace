import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { appendText, join, makeSandbox, seedRoom } from '../helpers/sandbox';
import { ERR, LIMITS } from '../../src/lib/constants';
import { computeJoinProof } from '../../src/lib/crypto/keys';
import { randomBytes } from '../../src/lib/encoding';

/**
 * The lifecycle the operator-facing spec pins down:
 * `ACTIVE -> IDLE_GRACE -> DESTROYING -> DESTROYED`, where IDLE_GRACE is a fixed 300-second
 * recovery window after the last valid participant goes, and DESTROYING is the point of no
 * return. The window is measured with the *shipped* constant and an injected clock, so these
 * legs read the number the product actually promises instead of a fixture's shortened one.
 */

const TTL = LIMITS.roomIdleTtlSeconds * 1000;

type Sbx = ReturnType<typeof makeSandbox>;

function msgCount(sbx: Sbx, roomId: string): number {
  return (sbx.db.raw.prepare('SELECT COUNT(*) c FROM messages WHERE room_id=?').get(roomId) as { c: number }).c;
}

function row(sbx: Sbx, roomId: string): { status: string; empty_since: number | null } | undefined {
  return sbx.db.raw.prepare('SELECT status, empty_since FROM rooms WHERE id=?').get(roomId) as
    | { status: string; empty_since: number | null }
    | undefined;
}

/** Let the scheduled cleanup finish; the destroy itself is fire-and-forget from the sweep. */
async function settle(sbx: Sbx, ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  void sbx;
}

describe('IDLE_GRACE holds the room instead of deleting it', () => {
  it('1. the last member leaving enters IDLE_GRACE with ciphertext and files untouched', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      const b = join(sbx, room, '乙', 1);
      await appendText(sbx, room, a, '窗口里必须还在', { n: 0 });
      expect(sbx.service.status(room.roomId).status).toBe('ACTIVE');

      sbx.service.leave(room.roomId, a.slot, a.gen);
      expect(sbx.service.status(room.roomId).status).toBe('ACTIVE');
      sbx.service.leave(room.roomId, b.slot, b.gen);

      expect(sbx.service.status(room.roomId).status).toBe('IDLE_GRACE');
      expect(sbx.service.status(room.roomId).joinable).toBe(true);
      expect(msgCount(sbx, room.roomId)).toBe(1);
      expect(row(sbx, room.roomId)?.empty_since).toBeTypeOf('number');
    } finally {
      sbx.close();
    }
  });

  it('2. rejoining at 299 s returns the same room and cancels the countdown', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      await appendText(sbx, room, a, '回归后要能读到', { n: 0 });
      const emptiedAt = Date.now();
      sbx.service.leave(room.roomId, a.slot, a.gen);
      sbx.service.tick(emptiedAt + 299_000);
      await settle(sbx);
      expect(sbx.service.status(room.roomId).status).toBe('IDLE_GRACE');

      const back = join(sbx, room, '甲回归');
      expect(sbx.service.status(room.roomId).status).toBe('ACTIVE');
      expect(row(sbx, room.roomId)?.empty_since).toBeNull();
      // Same room, not a new one: the history is still readable and the id did not change.
      expect(msgCount(sbx, room.roomId)).toBe(1);
      const page = sbx.service.history(room.roomId);
      expect(page.msgs.map((m) => m.seq)).toEqual([1]);
      // And the clock restarts from this departure, not from the one that was cancelled.
      const secondEmptiedAt = Date.now();
      sbx.service.leave(room.roomId, back.slot, back.gen);
      sbx.service.tick(secondEmptiedAt + 299_000);
      await settle(sbx);
      expect(sbx.service.status(room.roomId).status).toBe('IDLE_GRACE');
    } finally {
      sbx.close();
    }
  });

  it('3. at 301 s the room is destroyed and the same invite can no longer enter', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      const emptiedAt = Date.now();
      sbx.service.leave(room.roomId, a.slot, a.gen);
      sbx.service.tick(emptiedAt + TTL + 1_000);
      await settle(sbx);

      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
      const late = sbx.service.join(
        { roomId: room.roomId, proof: randomBytes(32), nick: new Uint8Array(1), nickNonce: randomBytes(12) },
        randomBytes(32)
      );
      expect(late.ok).toBe(false);
      expect(late.code).toBe(ERR.roomNotFound);
    } finally {
      sbx.close();
    }
  });

  it('4. a refresh that drops the socket does not destroy the room, and re-entry reads history', async () => {
    const { makeTestbed, newRoom, joinByInvite, waitFor } = await import('../helpers/testbed');
    const tb = await makeTestbed();
    try {
      const host = await newRoom(tb, '房主');
      await host.sendText('刷新后要能看到的一句话');
      await waitFor(() => host.list().length === 1, { label: 'message stored' });

      // A browser refresh is exactly this: the last socket in the room goes away.
      host.close();
      await waitFor(() => tb.srv.service.status(host.publicInvite.roomId).status === 'IDLE_GRACE', {
        label: 'room entered the recovery window'
      });
      // Nothing was deleted: the ciphertext history is still the single row it was.
      expect((tb.srv.db.raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(1);

      const reopened = await joinByInvite(tb, { code: host.publicInvite.code }, '刷新后的访客');
      expect(reopened.publicInvite.roomId).toBe(host.publicInvite.roomId);
      await reopened.loadOlder();
      await waitFor(() => reopened.list().some((m) => m.text === '刷新后要能看到的一句话'), {
        label: 'history readable after re-entry'
      });
      expect(tb.srv.service.status(host.publicInvite.roomId).status).toBe('ACTIVE');
      reopened.close();
    } finally {
      await tb.cleanup();
    }
  });

  it('5. interleaved joins and leaves leave no race between the ledger and memory', async () => {
    const sbx = makeSandbox();
    try {
      type Seat = { slot: number; gen: number; sessionToken: string };
      const room = seedRoom(sbx, 4);
      const sessions: Seat[] = [join(sbx, room, '甲'), join(sbx, room, '乙', 1)];
      for (let i = 0; i < 12; i++) {
        const at = i % sessions.length;
        const who = sessions[at] as Seat;
        if (i % 3 === 0) {
          sbx.service.leave(room.roomId, who.slot, who.gen);
          sessions[at] = join(sbx, room, `回归${i}`, i + 2);
        } else {
          sbx.service.heartbeat(room.roomId, who.slot, who.gen);
        }
      }
      const connectedRows = (
        sbx.db.raw.prepare('SELECT COUNT(*) c FROM slots WHERE room_id=? AND connected=1').get(room.roomId) as { c: number }
      ).c;
      expect(sbx.service.status(room.roomId).online).toBe(connectedRows);
      expect(sbx.service.status(room.roomId).online).toBeGreaterThan(0);
      expect(sbx.service.status(room.roomId).status).toBe('ACTIVE');
    } finally {
      sbx.close();
    }
  });

  it('6. once DESTROYING has begun, a new request, a refresh and a restart cannot revive it', async () => {
    const sbx = makeSandbox();
    const dataDir = sbx.dataDir;
    const dbFile = sbx.cfg.dbFile;
    const roomsDir = sbx.cfg.roomsDir;
    let roomId = '';
    try {
      const room = seedRoom(sbx);
      roomId = room.roomId;
      const a = join(sbx, room, '甲');
      await appendText(sbx, room, a, '销毁开始前的话', { n: 0 });
      sbx.service.leave(room.roomId, a.slot, a.gen);

      // Pin the room in DESTROYING with a storage that refuses to delete, then try to revive it
      // through every door the spec names.
      const storage = sbx.storage as unknown as { removeRoom: (id: string) => Promise<{ files: number; bytes: number }> };
      storage.removeRoom = async () => {
        throw new Error('simulated EBUSY');
      };
      const started = await sbx.service.destroy(room.roomId, 'idle');
      expect(started.ok).toBe(true);
      expect(started.report?.verifiedEmpty).toBe(false);
      expect(sbx.service.status(room.roomId).status).toBe('DESTROYING');

      const revive = await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);
      // A second destroy cannot claim a completion the first one did not deliver.
      expect(revive.ok).toBe(false);
      expect(revive.code).toBe(ERR.badState);
      expect(sbx.service.status(room.roomId).status).toBe('DESTROYING');
      const challenge = randomBytes(32);
      const attempt = sbx.service.join(
        {
          roomId,
          proof: computeJoinProof(room.keys.joinKey, roomId, challenge),
          nick: new Uint8Array(1),
          nickNonce: randomBytes(12)
        },
        challenge
      );
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe(ERR.roomDestroying);
      // The unfinished cleanup keeps its slot against MAX_ROOMS until the last byte is gone.
      expect(sbx.service.slotsHeld()).toBe(1);
      expect(sbx.service.pendingDestroys()).toEqual([roomId]);
    } finally {
      sbx.close(true);
    }
    void dataDir;
    void dbFile;
    void roomsDir;
  });

  it('7. a grace that expired while the process was down is closed out on startup', async () => {
    const { Db } = await import('../../src/server/db');
    const { RoomStorage } = await import('../../src/server/storage');
    const { RoomService } = await import('../../src/server/service');
    const { loadConfig } = await import('../../src/server/config');
    const sbx = makeSandbox();
    const dataDir = sbx.dataDir;
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      await appendText(sbx, room, a, '宕机期间过期的话', { n: 0 });
      sbx.service.leave(room.roomId, a.slot, a.gen);
      // Backdate the window start past the shipped TTL, as an outage would.
      sbx.db.raw.prepare('UPDATE rooms SET empty_since=? WHERE id=?').run(Date.now() - TTL - 60_000, room.roomId);
    } finally {
      sbx.close(true);
    }
    const db = new Db(path.join(dataDir, 'poofspace.sqlite'));
    const storage = new RoomStorage(path.join(dataDir, 'rooms'));
    const reopened = new RoomService(
      db,
      storage,
      { ...loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' } as NodeJS.ProcessEnv), env: 'test', dataDir }
    );
    try {
      const rec = await reopened.recoverOnStartup();
      expect(rec.expired.length).toBe(1);
      expect(reopened.stats().roomsIdleGrace).toBe(0);
      expect((db.raw.prepare('SELECT COUNT(*) c FROM rooms').get() as { c: number }).c).toBe(0);
      expect(await storage.listRoomDirs()).toEqual([]);
    } finally {
      reopened.stop();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('8. destroying one room leaves the other rooms and their data alone', async () => {
    const sbx = makeSandbox();
    try {
      const a = seedRoom(sbx);
      const b = seedRoom(sbx);
      const aWho = join(sbx, a, '甲');
      const bWho = join(sbx, b, '乙');
      await appendText(sbx, a, aWho, 'A 房间的话', { n: 0 });
      await appendText(sbx, b, bWho, 'B 房间的话', { n: 0 });

      await sbx.service.destroy(a.roomId, 'creator', a.creatorToken);

      expect(sbx.service.status(a.roomId).status).toBe('UNKNOWN');
      expect(sbx.service.status(b.roomId).status).toBe('ACTIVE');
      expect(msgCount(sbx, b.roomId)).toBe(1);
      expect(sbx.service.authorizeToken(bWho.sessionToken, b.roomId)).not.toBeNull();
      expect((sbx.db.raw.prepare('SELECT COUNT(*) c FROM slots WHERE room_id=?').get(b.roomId) as { c: number }).c).toBeGreaterThan(0);
      expect(sbx.service.slotsHeld()).toBe(1);
      const lateInA = sbx.service.join(
        { roomId: a.roomId, proof: randomBytes(32), nick: new Uint8Array(1), nickNonce: randomBytes(12) },
        randomBytes(32)
      );
      expect(lateInA.code).toBe(ERR.roomNotFound);
    } finally {
      sbx.close();
    }
  });
});
