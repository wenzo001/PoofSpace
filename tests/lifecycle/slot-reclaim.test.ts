import { describe, expect, it } from 'vitest';
import { appendText, join, makeSandbox, seedRoom } from '../helpers/sandbox';
import { ERR } from '../../src/lib/constants';
import { randomHex, utf8 } from '../../src/lib/encoding';

type Sbx = ReturnType<typeof makeSandbox>;

function slotRows(sbx: Sbx, roomId: string) {
  return sbx.db.raw
    .prepare('SELECT slot, gen, connected FROM slots WHERE room_id = ? ORDER BY slot')
    .all(roomId) as { slot: number; gen: number; connected: number }[];
}

const connectedRowCount = (sbx: Sbx, roomId: string) => slotRows(sbx, roomId).filter((r) => r.connected === 1).length;

/**
 * A slot number is re-issued to the next member that joins, so any event that arrives late
 * for an evicted connection names a slot some *other* session now owns. These legs pin down
 * that only the generation a connection actually holds may act on that slot.
 */
describe('a re-issued slot belongs only to its new generation', () => {
  it('a late leave from the evicted connection does not revoke the member that owns the slot', async () => {
    const sbx = makeSandbox({ roomIdleTtlMs: 600_000 });
    const room = seedRoom(sbx, 4);
    const departing = join(sbx, room, '离线的', 1);
    join(sbx, room, '旁观的', 2);

    sbx.service.leave(room.roomId, departing.slot, departing.gen);
    const successor = join(sbx, room, '接班的', 3);
    expect(successor.slot).toBe(departing.slot);
    expect(successor.gen).toBe(departing.gen + 1);

    // The departing socket's close event is only now processed, after the successor joined.
    sbx.service.leave(room.roomId, successor.slot, departing.gen);

    expect(sbx.service.status(room.roomId).online).toBe(2);
    expect(connectedRowCount(sbx, room.roomId)).toBe(2);
    const sent = await appendText(sbx, room, successor, '接班之后仍能发送', { n: 0 }).catch(() => undefined);
    expect(sent?.seq ?? 0).toBeGreaterThan(0);
    sbx.close();
  });

  it('a late heartbeat from the evicted connection does not keep a silent member online', () => {
    const sbx = makeSandbox({ roomIdleTtlMs: 600_000, heartbeatGraceMs: 60_000 });
    const room = seedRoom(sbx, 4);
    const departing = join(sbx, room, '离线的', 1);
    sbx.service.leave(room.roomId, departing.slot, departing.gen);
    const successor = join(sbx, room, '接班的', 2);
    expect(successor.slot).toBe(departing.slot);

    // Successor goes silent; the evicted socket keeps pinging on the slot it no longer holds.
    const pingedAt = Date.now() + 61_000;
    sbx.service.heartbeat(room.roomId, successor.slot, departing.gen, pingedAt);
    const swept = sbx.service.sweepHeartbeats(pingedAt + 1);

    expect(swept.dropped).toBe(1);
    expect(sbx.service.status(room.roomId).online).toBe(0);
    sbx.close();
  });

  it('a heartbeat from the generation that owns the slot keeps that member online', () => {
    // Control for the leg above: without it, an ignored heartbeat would look like success.
    const sbx = makeSandbox({ roomIdleTtlMs: 600_000, heartbeatGraceMs: 60_000 });
    const room = seedRoom(sbx, 4);
    const member = join(sbx, room, '在场的', 1);

    const later = Date.now() + 61_000;
    expect(sbx.service.heartbeat(room.roomId, member.slot, member.gen, later)).toBe(true);
    expect(sbx.service.sweepHeartbeats(later + 1).dropped).toBe(0);
    expect(sbx.service.status(room.roomId).online).toBe(1);
    sbx.close();
  });

  it('an upload reserved with the evicted generation is refused on the reused slot', () => {
    const sbx = makeSandbox({ roomIdleTtlMs: 600_000 });
    const room = seedRoom(sbx, 4);
    const departing = join(sbx, room, '离线的', 1);
    sbx.service.leave(room.roomId, departing.slot, departing.gen);
    const successor = join(sbx, room, '接班的', 2);
    expect(successor.slot).toBe(departing.slot);

    const res = sbx.service.createAttachment({
      roomId: room.roomId,
      slot: successor.slot,
      gen: departing.gen,
      attachmentId: randomHex(16),
      chunkSize: 1024,
      chunkCount: 1,
      totalBytes: 16,
      meta: utf8('x'),
      metaNonce: utf8('n'),
      kind: 'file'
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe(ERR.notMember);
    expect(
      (sbx.db.raw.prepare('SELECT COUNT(*) c FROM attachments WHERE room_id = ?').get(room.roomId) as { c: number }).c
    ).toBe(0);
    sbx.close();
  });
});

/**
 * Capacity is read from the slot rows while liveness lives in memory, so a row left
 * connected with no session behind it is held forever: joins keep coming back ROOM_FULL
 * even though nobody is in the room. The commit-then-bookkeep split in join() makes that
 * state reachable when a join is interrupted between the two, and nothing revisits the row.
 */
describe('capacity is never stranded on a row no connection owns', () => {
  it('reclaims an abandoned row so the room stops refusing joins', () => {
    const sbx = makeSandbox({ roomIdleTtlMs: 600_000, heartbeatGraceMs: 60_000, slotGraceMs: 4_000 });
    const room = seedRoom(sbx, 2);
    const live = join(sbx, room, '在房的', 1);

    const abandonedSlot = Math.max(...slotRows(sbx, room.roomId).map((r) => r.slot)) + 89;
    const now = Date.now();
    sbx.db.raw
      .prepare('INSERT INTO slots (room_id,slot,gen,is_creator,joined_at,last_seen,connected) VALUES (?, ?, 0, 0, ?, ?, 1)')
      .run(room.roomId, abandonedSlot, now, now);
    expect(connectedRowCount(sbx, room.roomId)).toBe(2);
    expect(sbx.service.status(room.roomId).online).toBe(1);

    sbx.service.sweepHeartbeats(now + sbx.cfg.slotGraceMs + 1);

    expect(connectedRowCount(sbx, room.roomId)).toBe(1);
    expect(sbx.service.status(room.roomId).online).toBe(1);

    const next = join(sbx, room, '新来的', 2);
    expect(next.slot).toBe(abandonedSlot);
    expect(next.slot).not.toBe(live.slot);
    expect(slotRows(sbx, room.roomId).length).toBe(2);
    sbx.close();
  });
});
