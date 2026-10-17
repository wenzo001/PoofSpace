import { describe, expect, it } from 'vitest';
import { join, makeSandbox, seedRoom } from '../helpers/sandbox';
import { ERR, IDLE_DELAY_CHOICES_MS } from '../../src/lib/constants';

const H = 3_600_000;

/**
 * A refusal is what the caller is owed. Without the length guard before `timingSafeEqual`, a
 * short token throws `RangeError: Input buffers must have the same byte length` instead, and that
 * surfaces as a runtime error in the red rather than as the product fact -- so the call is wrapped
 * and a throw is reported as its own answer.
 */
function answer(what: { code?: string; ok?: boolean }): string {
  return String(what.code ?? (what.ok ? 'OK' : 'REFUSED-WITHOUT-CODE'));
}

function refused(fn: () => { code?: string; ok?: boolean }): string {
  try {
    return answer(fn());
  } catch (err) {
    return `THREW ${String((err as Error).message).slice(0, 40)}`;
  }
}

describe('arming a delayed destroy', () => {
  it('1. only the six shipped choices are accepted', () => {
    // Written out rather than derived from the constant: if the list changes, this has to be
    // edited on purpose, and a range check that quietly accepts any positive number fails here.
    expect(IDLE_DELAY_CHOICES_MS).toEqual([4 * H, 8 * H, 12 * H, 24 * H, 36 * H, 72 * H]);
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      join(sbx, room, '甲');
      for (const bad of [5_000, 3 * H, 999 * H, 0, -H]) {
        expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken, bad).code, `refusing ${bad}`).toBe(ERR.badDelay);
      }
      for (const good of IDLE_DELAY_CHOICES_MS) {
        expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken, good).ok).toBe(true);
      }
      expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken, null).ok).toBe(true);
    } finally {
      sbx.close();
    }
  });

  it('2. the node cap refuses the N+1th arming, and re-arming is not a new one', () => {
    const sbx = makeSandbox({ maxDelayedRooms: 2 });
    try {
      const first = seedRoom(sbx);
      join(sbx, first, '甲');
      const second = seedRoom(sbx);
      join(sbx, second, '甲');
      const third = seedRoom(sbx);
      join(sbx, third, '甲');
      expect(sbx.service.setIdleDelay(first.roomId, first.creatorToken, 4 * H).ok).toBe(true);
      expect(sbx.service.setIdleDelay(second.roomId, second.creatorToken, 4 * H).ok).toBe(true);
      const refused = sbx.service.setIdleDelay(third.roomId, third.creatorToken, 4 * H);
      expect(refused.ok).toBe(false);
      expect(refused.code).toBe(ERR.delayCapacityFull);
      // Moving an existing arming to another tier must not be refused by the owner's own earlier
      // choice -- the cap counts rooms holding a window, not arming operations.
      expect(sbx.service.setIdleDelay(first.roomId, first.creatorToken, 8 * H).ok).toBe(true);
    } finally {
      sbx.close();
    }
  });

  it('3. a non-creator token cannot arm or read, whatever its shape', () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      join(sbx, room, '甲');
      expect(refused(() => sbx.service.setIdleDelay(room.roomId, '', 4 * H))).toBe(ERR.notCreator);
      expect(refused(() => sbx.service.setIdleDelay(room.roomId, 'aaaa', 4 * H))).toBe(ERR.notCreator);
      // Same length, wrong bytes: this is the arm that only a real comparison can refuse.
      const wrongLength = room.creatorToken.slice(0, -2) + 'AA';
      expect(refused(() => sbx.service.setIdleDelay(room.roomId, wrongLength, 4 * H))).toBe(ERR.notCreator);
      expect(refused(() => sbx.service.idleDelayFor(room.roomId, 'wrong'))).toBe(ERR.notCreator);
      const mine = sbx.service.idleDelayFor(room.roomId, room.creatorToken);
      expect(mine.ok).toBe(true);
      expect(mine.idleDelayMs).toBeNull();
    } finally {
      sbx.close();
    }
  });

  it('4. maxDelayedRooms=0 turns the feature off entirely', () => {
    const sbx = makeSandbox({ maxDelayedRooms: 0 });
    try {
      const room = seedRoom(sbx);
      join(sbx, room, '甲');
      expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken, 4 * H).code).toBe(ERR.delayCapacityFull);
      // Clearing is still allowed with the feature off, so an arming made before a config
      // tightening can always be taken back.
      expect(sbx.service.setIdleDelay(room.roomId, room.creatorToken, null).ok).toBe(true);
    } finally {
      sbx.close();
    }
  });
});
