import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  joinByInvite,
  makeBytes,
  makeTestbed,
  newRoom,
  sliceProvider,
  waitFor,
  type Testbed
} from '../helpers/testbed';
import type { ClientMessage, RoomClient } from '../../src/lib/client/roomclient';

/**
 * One Node process, one SQLite file, one hundred members: capacity, broadcast fan-out,
 * ordering under concurrent sends, reconnect churn, a transfer that must not starve chat,
 * and destroy under load. Gates are on shapes (set equality, gap-free sequences, row and
 * file counts), because a wall-clock budget cannot catch a 2x regression.
 */

const CAP = 100;

let tb: Testbed;
let host: RoomClient;
let members: RoomClient[] = [];

const countSql = (sql: string, ...args: (string | number)[]): number => {
  const row = tb.srv.db.raw.prepare(sql).get(...args) as { c: number };
  return row.c ?? 0;
};

const connected = (roomId: string): number =>
  countSql('SELECT COUNT(*) c FROM slots WHERE room_id = ? AND connected = 1', roomId);

const roomDir = (roomId: string): string => path.join(tb.srv.cfg.roomsDir, roomId);

const chunkFiles = (roomId: string): number => {
  const dir = roomDir(roomId);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? fs.readdirSync(path.join(dir, entry.name)).length : 1;
  }
  return n;
};

const acked = async (msg: ClientMessage, label: string): Promise<void> => {
  await waitFor(() => msg.state === 'sent', { label, timeoutMs: 20_000 });
};

beforeAll(async () => {
  tb = await makeTestbed({ maxMembersDefault: CAP });
  host = await newRoom(tb, '房主');
  members = await Promise.all(
    Array.from({ length: CAP - 1 }, (_, i) => joinByInvite(tb, { code: host.publicInvite.code }, `成员${i + 1}`))
  );
});

afterAll(async () => {
  for (const m of members) m.close();
  host.close();
  await tb?.cleanup();
});

describe('capacity at 100 members', () => {
  it('admits exactly 100 connected members and refuses the next', async () => {
    expect(members.length).toBe(CAP - 1);
    const roomId = host.publicInvite.roomId;
    expect(connected(roomId)).toBe(CAP);

    let refused = '';
    try {
      const extra = await joinByInvite(tb, { code: host.publicInvite.code }, '第 101 人');
      extra.close();
    } catch (err) {
      refused = (err as Error).message;
    }
    expect(refused).toContain('ROOM_FULL');
    expect(connected(roomId)).toBe(CAP);
  });

  it('shows every member the same roster of 100 online participants', async () => {
    for (const c of [host, members[0] as RoomClient, members[members.length - 1] as RoomClient]) {
      await waitFor(() => c.members.filter((m) => m.online).length === CAP, { label: `roster for ${c.nick}`, timeoutMs: 30_000 });
    }
  });
});

describe('broadcast fan-out', () => {
  it('delivers one message to all hundred members exactly once', async () => {
    const body = `广播-标记-${Math.random().toString(36).slice(2, 8)}`;
    const watchers = members.map((m) => ({ m, hits: () => m.list().filter((x) => x.text === body) }));
    const sent = await host.sendText(body);
    await acked(sent, 'sender acked');

    await waitFor(() => watchers.every((w) => w.hits().length === 1), { label: 'all hundred received', timeoutMs: 40_000 });
    for (const w of watchers) expect(w.hits()).toHaveLength(1);
  });

  it('keeps every member on one order when many send at once', async () => {
    const senders = members.slice(0, 40);
    const marker = `并发-${Math.random().toString(36).slice(2, 8)}`;
    await Promise.all(senders.map((c, i) => c.sendText(`${marker}-${i}`)));

    const witnesses = [host, members[0] as RoomClient, members[20] as RoomClient, members[members.length - 1] as RoomClient];
    const count = (c: RoomClient) => c.list().filter((m) => m.text.startsWith(marker)).length;
    await waitFor(() => witnesses.every((c) => count(c) === senders.length), { label: 'witnesses converged', timeoutMs: 40_000 });

    const seqs = (witnesses[1] as RoomClient).list().filter((m) => m.text.startsWith(marker)).map((m) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.max(...seqs) - Math.min(...seqs)).toBe(seqs.length - 1);

    const orderOf = (c: RoomClient) =>
      c.list().filter((m) => m.text.startsWith(marker)).sort((a, b) => a.seq - b.seq).map((m) => m.text).join('|');
    const reference = orderOf(witnesses[0] as RoomClient);
    for (const c of witnesses.slice(1)) expect(orderOf(c)).toBe(reference);
  });
});

describe('reconnect churn', () => {
  it('re-issues slots without piling up sessions or member ids', async () => {
    const roomId = host.publicInvite.roomId;
    // Rows are the ledger a join is checked against and memory is the session that
    // authorises a member. If they disagree, an unrelated join is refused ROOM_FULL for
    // capacity that nobody holds, so the churn reports the ledger it was refusing.
    const ledger = () => ({
      rows: connected(roomId),
      online: tb.srv.service.status(roomId).online
    });
    const churn = members.slice(0, 20);
    for (const c of churn) c.close();
    await waitFor(() => connected(roomId) === CAP - churn.length, { label: 'departures counted', timeoutMs: 20_000 });
    expect(
      countSql('SELECT COUNT(*) c FROM session_tokens WHERE room_id = ?', roomId)
    ).toBeLessThanOrEqual(CAP - churn.length);

    const back = await Promise.all(
      churn.map(async (c, i) => {
        try {
          return await joinByInvite(tb, { code: host.publicInvite.code }, `回归${i}`);
        } catch (err) {
          throw new Error(`${(err as Error).message} while rejoining, ledger ${JSON.stringify(ledger())}`);
        }
      })
    );
    members = members.map((m) => {
      const at = churn.indexOf(m);
      return at >= 0 ? (back[at] as RoomClient) : m;
    });
    await waitFor(() => connected(roomId) === CAP, { label: 'all back online', timeoutMs: 30_000 });
    expect(ledger()).toEqual({ rows: CAP, online: CAP });
    // The sweep that reclaims abandoned rows must leave members who are heartbeating alone.
    tb.srv.service.sweepHeartbeats();
    expect(ledger()).toEqual({ rows: CAP, online: CAP });

    const maxSlot = (tb.srv.db.raw.prepare('SELECT MAX(slot) m FROM slots WHERE room_id = ?').get(roomId) as { m: number }).m;
    const rows = countSql('SELECT COUNT(*) c FROM slots WHERE room_id = ?', roomId);
    // Slot ids are a 3-byte nonce field: churn must keep them bounded by the member cap,
    // not march towards 2^24, and rows must not accumulate per reconnect.
    expect(maxSlot).toBeLessThan(CAP * 2);
    expect(rows).toBeLessThanOrEqual(CAP);
  });
});

describe('large transfer under load', () => {
  it('still acks text while a multi-chunk attachment is in flight', async () => {
    const body = makeBytes(3 * 1024 * 1024, 7);
    const upload = host.upload({
      name: '负载中的大文件.bin',
      mime: 'application/octet-stream',
      size: body.length,
      kind: 'file',
      slice: sliceProvider(body),
      chunkSize: 256 * 1024,
      concurrency: 4
    });

    const chatter = await Promise.all(
      [members[0] as RoomClient, members[1] as RoomClient, members[2] as RoomClient].map((c) => c.sendText(`传输期间-${c.nick}`))
    );
    for (const m of chatter) await acked(m, 'text during upload');

    const done = await upload;
    expect(done.meta.chunkCount).toBe(12);
    await acked(done.msg, 'attachment announced');
    expect(chunkFiles(host.publicInvite.roomId)).toBe(12);
  });
});

describe('long-run storage hygiene', () => {
  it('records exactly what was sent, and keeps no abandoned reservations', async () => {
    const roomId = host.publicInvite.roomId;
    const ids: string[] = [];
    const sent: ClientMessage[] = [];
    for (let i = 0; i < 12; i++) sent.push(await host.sendText(`长跑-${i}`));
    for (const m of sent) await acked(m, '长跑 acked');
    for (const m of sent) ids.push(m.clientMsgId);
    const marks = ids.map(() => '?').join(',');
    expect(
      countSql(`SELECT COUNT(*) c FROM messages WHERE room_id = ? AND client_msg_id IN (${marks})`, roomId, ...ids)
    ).toBe(12);
    expect(countSql("SELECT COUNT(*) c FROM attachments WHERE state = 'PENDING'")).toBe(0);
    expect(countSql('SELECT COUNT(*) c FROM attachments WHERE room_id = ? AND complete = 0', roomId)).toBe(0);
  });
});

describe('destroy under full load', () => {
  it('tells every live connection the room is gone and clears controlled storage', async () => {
    // A fresh room with its own crowd: the notification gate must not depend on how long
    // the shared room has been alive under the other load tests.
    const crowd = 40;
    const room = await newRoom(tb, '热闹房主');
    const guests: RoomClient[] = [];
    for (let i = 0; i < crowd; i++) guests.push(await joinByInvite(tb, { code: room.publicInvite.code }, `看客${i}`));

    const told = new Set<string>();
    for (const g of guests) g.on((e) => void (e.type === 'destroyed' && told.add(g.nick)));
    expect(connected(room.publicInvite.roomId)).toBe(crowd + 1);

    await room.destroy();
    await waitFor(() => told.size === crowd, { label: 'every member told', timeoutMs: 30_000 });

    const roomId = room.publicInvite.roomId;
    await waitFor(() => !fs.existsSync(roomDir(roomId)), { label: 'attachment dir removed', timeoutMs: 15_000 });
    expect(countSql('SELECT COUNT(*) c FROM messages WHERE room_id = ?', roomId)).toBe(0);
    expect(countSql('SELECT COUNT(*) c FROM attachments WHERE room_id = ?', roomId)).toBe(0);
    expect(countSql('SELECT COUNT(*) c FROM slots WHERE room_id = ?', roomId)).toBe(0);
    expect(countSql('SELECT COUNT(*) c FROM session_tokens WHERE room_id = ?', roomId)).toBe(0);

    let rejoin = '';
    try {
      const late = await joinByInvite(tb, { code: guests[0]!.publicInvite.code }, '复活尝试');
      late.close();
    } catch (err) {
      rejoin = (err as Error).message;
    }
    expect(rejoin.length).toBeGreaterThan(0);

    for (const g of guests) g.close();
  });
});
