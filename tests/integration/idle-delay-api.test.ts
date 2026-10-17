import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinByInvite, makeTestbed, newRoom, type Testbed } from '../helpers/testbed';

const H = 3_600_000;

let tb: Testbed;

beforeAll(async () => {
  tb = await makeTestbed();
});

afterAll(async () => {
  await tb.cleanup();
});

/**
 * The service layer is covered with its own knives; this file exists for the edge between the
 * client and the route. A body/header mis-wiring keeps every service test green, so the round trip
 * is asserted through the same methods the UI will call.
 */
describe('the delay routes, over real HTTP', () => {
  it('1. arming through the client reads back through the client', async () => {
    const owner = await newRoom(tb);
    expect(await owner.getIdleDelay()).toBeNull();
    await owner.setIdleDelay(8 * H);
    expect(await owner.getIdleDelay()).toBe(8 * H);
    await owner.setIdleDelay(24 * H);
    expect(await owner.getIdleDelay()).toBe(24 * H);
    await owner.setIdleDelay(null);
    expect(await owner.getIdleDelay()).toBeNull();
  });

  it('2. a choice outside the six is refused on the wire, not just in the dialog', async () => {
    const owner = await newRoom(tb);
    await expect(owner.setIdleDelay(5_000)).rejects.toThrow(/403/);
    expect(await owner.getIdleDelay()).toBeNull();
  });

  it('3. a member who never held the owner credential gets nothing', async () => {
    const owner = await newRoom(tb);
    await owner.setIdleDelay(4 * H);
    const member = await joinByInvite(tb, owner.publicInvite, '乙');
    await expect(member.setIdleDelay(4 * H)).rejects.toThrow();
    await expect(member.getIdleDelay()).rejects.toThrow();
    // The owner's arming is untouched by either attempt.
    expect(await owner.getIdleDelay()).toBe(4 * H);
  });

  /**
   * Placement matters as much as the check: the route has to sit *behind* the session gate, or an
   * anonymous caller could probe room ids for which the answer differs. A member's client refuses
   * locally before sending anything, so only this raw request proves the order.
   */
  it('4. without a room session the route is refused before the creator check runs', async () => {
    const owner = await newRoom(tb);
    const roomId = owner.publicInvite.link.split('/room/')[1]?.split('#')[0] ?? '';
    expect(roomId.length).toBeGreaterThan(10);
    const anonymous = await fetch(`${tb.base}/api/rooms/${roomId}/delay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creatorToken: 'not-a-token', idleDelayMs: 4 * H })
    });
    expect(anonymous.status).toBe(401);
    const readAnonymous = await fetch(`${tb.base}/api/rooms/${roomId}/delay`);
    expect(readAnonymous.status).toBe(401);
    expect(await owner.getIdleDelay()).toBeNull();
  });
});
