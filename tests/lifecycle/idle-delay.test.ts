import { describe, expect, it } from 'vitest';
import { join, makeSandbox, seedRoom } from '../helpers/sandbox';

const H = 3_600_000;
/** The node default is pinned as a literal, not read from config: an expectation computed from the
 *  constant under test would pass whatever that constant is set to. */
const DEFAULT_TTL = 300_000;

interface Row {
  status: string;
  empty_since: number | null;
  idle_delay_ms: number | null;
}

function delayRow(sbx: ReturnType<typeof makeSandbox>, roomId: string): Row {
  return sbx.db.raw
    .prepare('SELECT status, empty_since, idle_delay_ms FROM rooms WHERE id=?')
    .get(roomId) as Row;
}

/** Arms the window the way Task 3's endpoint will end up doing it, written straight to the row so
 *  this file can speak about lifecycle before the HTTP surface exists. */
function arm(sbx: ReturnType<typeof makeSandbox>, roomId: string, ms: number): void {
  sbx.db.raw.prepare('UPDATE rooms SET idle_delay_ms=? WHERE id=?').run(ms, roomId);
}

function emptyTheRoom(sbx: ReturnType<typeof makeSandbox>, roomId: string, who: { slot: number; gen: number }[]): void {
  for (const w of who) sbx.service.leave(roomId, w.slot, w.gen);
}

/**
 * `sweepIdleGrace` names a room destroyed and then cleans it up asynchronously, so a test that
 * closes the sandbox right after the assertion leaves that chain writing to a closed connection --
 * vitest reports it as an unhandled rejection and warns that the pass may be false. Wait for the
 * row to be gone instead: that is the thing being claimed, and it has a falling edge.
 */
async function gone(sbx: ReturnType<typeof makeSandbox>, roomId: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const c = (sbx.db.raw.prepare('SELECT COUNT(*) c FROM rooms WHERE id=?').get(roomId) as { c: number }).c;
    if (c === 0) return;
    if (Date.now() - started > 5000) {
      throw new Error(`the room still has a row 5s after the sweep named it destroyed: ${roomId.slice(0, 6)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('a per-room window extends the hold without a second deadline', () => {
  it('1. an armed room is still alive at 71:59:59 and gone at 72:00:01', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      arm(sbx, room.roomId, 72 * H);
      const t0 = Date.now();
      emptyTheRoom(sbx, room.roomId, [a]);
      expect(delayRow(sbx, room.roomId).status).toBe('IDLE_GRACE');

      let out = sbx.service.sweepIdleGrace(t0 + 72 * H - 1_000);
      expect(out.destroyed).toEqual([]);
      expect(delayRow(sbx, room.roomId).status).toBe('IDLE_GRACE');

      out = sbx.service.sweepIdleGrace(t0 + 72 * H + 1_000);
      expect(out.destroyed).toContain(room.roomId);
      await gone(sbx, room.roomId);
      expect(sbx.db.raw.prepare('SELECT COUNT(*) c FROM rooms').get()).toEqual({ c: 0 });
    } finally {
      sbx.close();
    }
  });

  it('2. an unarmed room still dies on the node default', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      const t0 = Date.now();
      emptyTheRoom(sbx, room.roomId, [a]);
      expect(sbx.service.sweepIdleGrace(t0 + DEFAULT_TTL + 1_000).destroyed).toContain(room.roomId);
      await gone(sbx, room.roomId);
    } finally {
      sbx.close();
    }
  });

  /**
   * The sweep has one judge and startup has another. This is the arm that only the second one can
   * fail, which is what makes it the witness for "both places ask the same question" -- fixing the
   * sweep alone leaves this red.
   */
  it('3. a restart inside the window keeps both the room and its deadline', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const a = join(sbx, room, '甲');
      const t0 = Date.now();
      arm(sbx, room.roomId, 72 * H);
      emptyTheRoom(sbx, room.roomId, [a]);
      const before = delayRow(sbx, room.roomId);
      expect(before.empty_since).not.toBeNull();
      await sbx.service.recoverOnStartup(t0 + 6 * H);
      // Asserted before the row is read: with the startup judge asking the node default the room is
      // destroyed outright, and `delayRow` then returns undefined -- a TypeError would be the red,
      // which says "the fixture broke" instead of "an armed room was destroyed on boot".
      expect(sbx.db.raw.prepare('SELECT COUNT(*) c FROM rooms').get(), 'an armed room must survive a restart inside its window').toEqual({ c: 1 });
      const after = delayRow(sbx, room.roomId);
      expect(after.status).toBe('IDLE_GRACE');
      expect(after.empty_since).toBe(before.empty_since);
      expect(after.idle_delay_ms).toBe(72 * H);
    } finally {
      sbx.close();
    }
  });

  it('4. a member arriving mid-countdown cancels it and consumes the arming', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const t0 = Date.now();
      const a = join(sbx, room, '甲');
      arm(sbx, room.roomId, 8 * H);
      emptyTheRoom(sbx, room.roomId, [a]);
      expect(sbx.service.sweepIdleGrace(t0 + 2 * H).destroyed).toEqual([]);
      const b = join(sbx, room, '乙', 1);
      expect(delayRow(sbx, room.roomId).idle_delay_ms).toBeNull();
      expect(delayRow(sbx, room.roomId).status).toBe('ACTIVE');
      // Empty again with no flag left: the node default applies, and the arming is not reusable.
      emptyTheRoom(sbx, room.roomId, [b]);
      const t1 = Date.now();
      expect(sbx.service.sweepIdleGrace(t1 + DEFAULT_TTL + 1_000).destroyed).toContain(room.roomId);
      await gone(sbx, room.roomId);
    } finally {
      sbx.close();
    }
  });

  it('5. a join while the room is still ACTIVE leaves the arming in place', () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      arm(sbx, room.roomId, 8 * H);
      join(sbx, room, '甲');
      join(sbx, room, '乙', 1);
      expect(delayRow(sbx, room.roomId).idle_delay_ms).toBe(8 * H);
      expect(delayRow(sbx, room.roomId).status).toBe('ACTIVE');
    } finally {
      sbx.close();
    }
  });

  /**
   * There are two ways a countdown is cancelled and they are different code: `join` takes the row
   * out of IDLE_GRACE itself, while a member who is already connected is handled by
   * `cancelEmptyTimer` inside the sweep. Without this arm, deleting the clear from that second path
   * would be invisible -- test 4 only walks the first one.
   */
  it('6. a connected member found by the sweep cancels the countdown and the arming', () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      arm(sbx, room.roomId, 8 * H);
      join(sbx, room, '甲');
      // The shape between two ticks: somebody left and the row went idle, while memory still holds
      // a live member. This is the only reachable route into cancelEmptyTimer.
      sbx.db.raw
        .prepare("UPDATE rooms SET status='IDLE_GRACE', empty_since=? WHERE id=?")
        .run(Date.now() - 1000, room.roomId);
      const out = sbx.service.sweepIdleGrace(Date.now());
      expect(out.cancelled).toBe(1);
      expect(out.destroyed).toEqual([]);
      const row = delayRow(sbx, room.roomId);
      expect(row.status).toBe('ACTIVE');
      expect(row.idle_delay_ms).toBeNull();
    } finally {
      sbx.close();
    }
  });
});
