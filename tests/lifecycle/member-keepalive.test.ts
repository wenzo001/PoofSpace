import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/lib/constants';
import { joinByInvite, makeTestbed, newRoom, type Testbed } from '../helpers/testbed';
import type { RoomClient } from '../../src/lib/client/roomclient';

/**
 * A member that is talking is alive. Only `ping` frames used to refresh the server's idea
 * of liveness, so on a busy single process a chat partner could be evicted while its socket
 * was open and its messages were flowing — which shows up in a 100-member room as members
 * silently vanishing from the roster.
 */
let tb: Testbed;
let host: RoomClient;
let guest: RoomClient;

beforeAll(async () => {
  tb = await makeTestbed({
    heartbeatServerMs: 400,
    heartbeatGraceMs: 1_500,
    slotGraceMs: 60_000,
    roomIdleTtlMs: 600_000
  });
  host = await newRoom(tb, '房主');
  guest = await joinByInvite(tb, { code: host.publicInvite.code }, '只聊不 ping 的成员');
});

afterAll(async () => {
  guest?.close();
  host?.close();
  await tb?.cleanup();
});

/**
 * Shipped cadence, not fixture cadence: a grace shorter than a few client intervals evicts a
 * member whose tab was merely throttled. 25 s against a 15 s ping was 1.7 intervals, and the
 * 100-member churn leg reaped three live participants through exactly this gap.
 */
it('ships a heartbeat grace that tolerates several missed pings', () => {
  expect(LIMITS.heartbeatGraceMs).toBeGreaterThanOrEqual(3 * LIMITS.heartbeatClientMs);
});

describe('member liveness', () => {
  it('keeps a member that is sending traffic but has not pinged yet', async () => {
    const roomId = host.publicInvite.roomId;
    let cuts = 0;
    guest.on((e) => void (e.type === 'disconnected' && cuts++));

    // The client's own heartbeat is 15 s away; the grace window is 1.5 s, so this is the
    // only thing that can keep the session: the message itself.
    await new Promise((r) => setTimeout(r, 1_200));
    const msg = await guest.sendText('只靠业务帧续命');
    await new Promise((r) => setTimeout(r, 1_400));

    expect(msg.state).toBe('sent');
    expect(cuts).toBe(0);
    expect(tb.srv.service.status(roomId).online).toBe(2);
  });

  /**
   * The call edge this pins is `pong -> service.heartbeat`. A member that says nothing at all
   * (an open tab in the background) sends no application frame for 15 s, which is ten times this
   * fixture's grace; only the protocol pong, answered by the network layer rather than by page
   * timers, can keep its seat. Delete that one call and this goes red while the leg above stays
   * green — which is the point: the two proofs are different edges.
   */
  it('keeps an idle member alive through the protocol pong, not only through its messages', async () => {
    const roomId = host.publicInvite.roomId;
    const idle = await joinByInvite(tb, { code: host.publicInvite.code }, '全程不说话的成员');
    let cuts = 0;
    idle.on((e) => void (e.type === 'disconnected' && cuts++));
    try {
      // Four grace periods with nothing sent: 6 s of silence against a 1.5 s cutoff.
      await new Promise((r) => setTimeout(r, 6_000));
      expect(tb.srv.service.status(roomId).online).toBe(3);
      expect(cuts).toBe(0);
      expect(idle.members.filter((m) => m.online).length).toBe(3);
      expect(idle.status).toBe('open');
    } finally {
      idle.close();
    }
  });
});
