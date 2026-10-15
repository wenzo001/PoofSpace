import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinByInvite, makeTestbed, newRoom, waitFor, type Testbed } from '../helpers/testbed';
import type { ClientMessage, RoomClient } from '../../src/lib/client/roomclient';

/**
 * Capacity must come back the moment a member really leaves, and a member who stays
 * must keep a live session. Both directions are checked here because the 100-member
 * churn lane failed intermittently with ROOM_FULL: a slot row can report connected=1
 * while no in-memory session backs it (phantom occupant), or the other way round
 * (a live member nobody will accept a message from). Small caps, many rounds, so the
 * race has to be won repeatedly instead of once.
 */

const CAP = 8;
const CHURN = 4;
const ROUNDS = 12;

let tb: Testbed;

const dbConnected = (roomId: string): number =>
  (tb.srv.db.raw.prepare('SELECT COUNT(*) c FROM slots WHERE room_id=? AND connected=1').get(roomId) as { c: number }).c;

const slotFlags = (roomId: string): string =>
  (tb.srv.db.raw.prepare('SELECT slot, connected FROM slots WHERE room_id=? ORDER BY slot').all(roomId) as { slot: number; connected: number }[])
    .map((r) => `${r.slot}:${r.connected}`)
    .join(',');

async function settleAck(client: RoomClient, body: string, label: string): Promise<void> {
  const msg: ClientMessage = await client.sendText(body);
  await waitFor(() => msg.state === 'sent', { label, timeoutMs: 15_000 });
}

beforeAll(async () => {
  tb = await makeTestbed({ maxMembersDefault: CAP });
});

afterAll(async () => {
  await tb?.cleanup();
});

describe('capacity returns when members leave', () => {
  it(`releases and re-takes ${CHURN} of ${CAP} slots for ${ROUNDS} rounds without ROOM_FULL or dead sessions`, async () => {
    const problems: string[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      const host = await newRoom(tb, `房主${round}`, CAP);
      const roomId = host.publicInvite.roomId;
      const guests: RoomClient[] = [];
      for (let i = 0; i < CAP - 1; i++) {
        guests.push(await joinByInvite(tb, { code: host.publicInvite.code }, `成员${round}-${i}`));
      }
      expect(dbConnected(roomId)).toBe(CAP);

      const leaving = guests.slice(0, CHURN);
      const staying = guests.slice(CHURN);
      for (const c of leaving) c.close();
      await waitFor(() => dbConnected(roomId) === CAP - CHURN, { label: `round ${round} departures counted`, timeoutMs: 15_000 });

      let back: RoomClient[] = [];
      try {
        back = await Promise.all(leaving.map((_, i) => joinByInvite(tb, { code: host.publicInvite.code }, `回归${round}-${i}`)));
      } catch (err) {
        problems.push(`round ${round}: rejoin refused ${(err as Error).message}; flags [${slotFlags(roomId)}] connected=${dbConnected(roomId)}`);
      }

      if (back.length === CHURN) {
        if (dbConnected(roomId) !== CAP) {
          problems.push(`round ${round}: capacity reads ${dbConnected(roomId)} after everyone is back, expected ${CAP}; flags [${slotFlags(roomId)}]`);
        }
        // Every member the test still holds a socket for must be able to talk: a slot row
        // that says connected=1 with no session behind it shows up here as a rejected send.
        for (const [at, c] of [host, ...staying, ...back].entries()) {
          try {
            await settleAck(c, `在位-${round}-${at}`, `round ${round} member ${at} acked`);
          } catch (err) {
            problems.push(`round ${round}: member ${at} cannot send (${(err as Error).message}); flags [${slotFlags(roomId)}]`);
            break;
          }
        }
        for (const c of back) c.close();
      }

      for (const c of staying) c.close();
      host.close();
    }

    expect(problems).toEqual([]);
  }, 180_000);
});
