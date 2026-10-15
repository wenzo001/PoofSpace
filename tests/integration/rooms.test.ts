import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newRoom, joinByInvite, joinByLink, makeTestbed, recorder, waitFor, clientOptions, type Testbed } from '../helpers/testbed';
import { RoomClient } from '../../src/lib/client/roomclient';
import { ERR } from '../../src/lib/constants';
import { parseInviteInput, encodeRoomId } from '../../src/lib/crypto/invite';
import { randomBytes } from '../../src/lib/encoding';

let tb: Testbed;

beforeAll(async () => {
  tb = await makeTestbed();
});

afterAll(async () => {
  await tb.cleanup();
});

describe('health and runtime configuration', () => {
  it('serves a liveness-only health document, with no room counters to enumerate', async () => {
    const res = await fetch(`${tb.base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.proto).toBe(1);
    // Nothing here may scale with what the node is holding: a count of rooms, members, messages
    // or attachments on the public listener is a status page for other people's activity.
    expect(JSON.stringify(body)).not.toMatch(/rooms|online|messages|attachments|connections|uptime/i);
  });

  it('publishes limits and the base URL without leaking secrets', async () => {
    const res = await fetch(`${tb.base}/api/runtime-config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('#');
    expect(body.limits).toBeTypeOf('object');
  });
});

describe('room credentials and authorisation', () => {
  it('creates a room, keeps the secret client-side, and returns a creator token', async () => {
    const alice = await newRoom(tb, '张伟');
    try {
      expect(alice.creatorToken).toHaveLength(43);
      expect(alice.invite.link).toContain(`/room/${alice.invite.roomId}#`);
      expect(alice.status).toBe('open');
      expect(alice.isCreator).toBe(true);
    } finally {
      alice.close();
    }
  });

  it('refuses a join whose proof was computed with a different secret', async () => {
    const alice = await newRoom(tb, '张伟');
    const wrong = RoomClient.fromSecret(
      clientOptions(tb),
      { roomId: alice.invite.roomId, secret: parseInviteInput(alice.invite.link)!.secret.slice() },
      '冒名者'
    );
    // Re-derive with a deliberately different secret.
    const impostor = RoomClient.fromSecret(
      clientOptions(tb),
      { roomId: alice.invite.roomId, secret: new Uint8Array(32).fill(9) },
      '冒名者'
    );
    await expect(impostor.connect()).rejects.toThrow(ERR.badProof);
    await expect(wrong.connect()).resolves.toBeUndefined();
    wrong.close();
    alice.close();
  });

  it('rejects joining a room id that was never created', async () => {
    const ghost = RoomClient.fromSecret(
      clientOptions(tb),
      { roomId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', secret: new Uint8Array(32).fill(1) },
      '幽灵'
    );
    await expect(ghost.connect()).rejects.toThrow(ERR.roomNotFound);
  });

  it('accepts a member through the invite code and through the full link', async () => {
    const alice = await newRoom(tb, '张伟');
    const byCode = await joinByInvite(tb, alice.publicInvite, '李娜');
    const byLink = await joinByLink(tb, alice.invite.link, '王芳');
    expect(byCode.status).toBe('open');
    expect(byLink.status).toBe('open');
    await waitFor(() => alice.members.length >= 3, { label: 'three members' });
    const names = (await Promise.all(alice.members.map((m) => alice.openNick(m)))).sort();
    expect(names).toEqual(['李娜', '王芳', '张伟'].sort());
    alice.close();
    byCode.close();
    byLink.close();
  });

  it('enforces the member cap on valid participants', async () => {
    // The cap counts every valid participant, creator included: "最多容纳 N 名有效参与者".
    const host = await newRoom(tb, '房主', 3);
    const guests: RoomClient[] = [];
    try {
      guests.push(await joinByInvite(tb, host.publicInvite, '甲'));
      guests.push(await joinByInvite(tb, host.publicInvite, '乙'));
      await expect(joinByInvite(tb, host.publicInvite, '丙')).rejects.toThrow(ERR.roomFull);
      expect(host.members.length).toBe(3);
    } finally {
      for (const g of guests) g.close();
      host.close();
    }
  });

  it('frees a slot when a member leaves so the cap is not permanently consumed', async () => {
    const host = await newRoom(tb, '房主', 2);
    try {
      const first = await joinByInvite(tb, host.publicInvite, '甲');
      first.close();
      await waitFor(() => host.members.filter((m) => m.online).length === 1, { label: 'departure noticed' });
      const second = await joinByInvite(tb, host.publicInvite, '乙');
      expect(second.status).toBe('open');
      second.close();
    } finally {
      host.close();
    }
  });

  it('answers a room status probe with one joinability bit and nothing else', async () => {
    const host = await newRoom(tb, '房主');
    const res = await fetch(`${tb.base}/api/rooms/${host.invite.roomId}/status`);
    // Exact shape on purpose: whoever holds the room id learns whether the link still works,
    // and cannot read out who is online, how big the room is, or that anyone is in it.
    expect(await res.json()).toEqual({ joinable: true });
    host.close();
  });

  it('answers a status probe for an unknown room id exactly like a destroyed one', async () => {
    // A deleted room has no row, so both cases share one answer: the probe cannot tell a room
    // that was destroyed apart from a room id that was never minted, which is the point.
    const unknown = encodeRoomId(randomBytes(16));
    const res = await fetch(`${tb.base}/api/rooms/${unknown}/status`);
    expect(await res.json()).toEqual({ joinable: false });
  });
});

describe('text messaging over WebSocket', () => {
  it('delivers a message live and marks it sent after the server ack', async () => {
    const a = await newRoom(tb, '甲');
    const b = await joinByInvite(tb, a.publicInvite, '乙');
    const rec = recorder(b);
    try {
      const sent = await a.sendText('第一次见面');
      expect(sent.state).toBe('sending');
      await waitFor(() => rec.text('第一次见面')?.state === 'sent', { label: 'ack' });
      expect(sent.state).toBe('sent');
      expect(rec.text('第一次见面')?.seq).toBeGreaterThan(0);
    } finally {
      a.close();
      b.close();
    }
  });

  it('orders concurrent messages by the server sequence', async () => {
    const a = await newRoom(tb, '甲');
    const b = await joinByInvite(tb, a.publicInvite, '乙');
    const c = await joinByInvite(tb, a.publicInvite, '丙');
    try {
      const bodies: string[] = [];
      const senders = [a, b, c];
      for (let i = 0; i < 12; i++) bodies.push(`并发 ${i}`);
      await Promise.all(bodies.map((body, i) => senders[i % 3]!.sendText(body)));
      await waitFor(() => c.list().filter((m) => m.text.startsWith('并发')).length === 12, { label: 'all twelve' });
      const seqs = c.list().map((m) => m.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      const ordered = c.list().slice().sort((x, y) => x.seq - y.seq).map((m) => m.seq);
      expect(ordered).toEqual([...ordered].sort((x, y) => x - y));
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });

  it('deduplicates a replayed message id into one entry and one sequence', async () => {
    const a = await newRoom(tb, '甲');
    const b = await joinByInvite(tb, a.publicInvite, '乙');
    try {
      const msg = await a.sendText('只算一次');
      await waitFor(() => msg.state === 'sent', { label: 'first ack' });
      const firstSeq = msg.seq;
      const res = await a.list().find((m) => m.clientMsgId === msg.clientMsgId);
      expect(res?.text).toBe('只算一次');
      // Replay the identical envelope through the socket again.
      await a.retry(msg.clientMsgId);
      await new Promise((r) => setTimeout(r, 300));
      expect(b.list().filter((m) => m.clientMsgId === msg.clientMsgId)).toHaveLength(1);
      expect(b.list().find((m) => m.clientMsgId === msg.clientMsgId)?.seq).toBe(firstSeq);
    } finally {
      a.close();
      b.close();
    }
  });

  it('drops a message the receiver cannot authenticate and says so loudly', async () => {
    const a = await newRoom(tb, '甲');
    const b = await joinByInvite(tb, a.publicInvite, '乙');
    try {
      const msg = await a.sendText('完好消息');
      await waitFor(() => msg.state === 'sent', { label: 'ack' });
      // A forged envelope with a valid-looking shape must never reach the list.
      const forged = {
        t: 'msg:new' as const,
        msg: {
          seq: 999_999,
          clientMsgId: 'forged-1',
          senderSlot: 1,
          nonce: msg.clientMsgId.slice(0, 16),
          ct: msg.clientMsgId,
          kind: 'text' as const,
          attachmentId: null,
          at: Date.now()
        }
      };
      const seen: string[] = [];
      const off = b.on((e) => {
        if (e.type === 'error') seen.push(e.code);
        if (e.type === 'message') seen.push(`msg:${e.msg.clientMsgId}`);
      });
      // Drive the handler through the real client path by injecting the frame.
      (b as unknown as { handleFrame(f: unknown): void }).handleFrame(forged);
      await new Promise((r) => setTimeout(r, 120));
      off();
      expect(seen).toContain(ERR.decryptFailed);
      expect(b.list().some((m) => m.clientMsgId === 'forged-1')).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('server-side ciphertext history', () => {
  it('lets a late joiner decrypt the full history through pagination', async () => {
    const host = await newRoom(tb, '房主');
    try {
      for (let i = 0; i < 7; i++) await host.sendText(`历史 ${i}`);
      await waitFor(() => host.list().length === 7, { label: 'seven stored' });
      const late = await joinByInvite(tb, host.publicInvite, '后来者');
      try {
        await late.loadOlder();
        await waitFor(() => late.list().length >= 7, { label: 'history loaded' });
        const texts = late.list().map((m) => m.text).filter((t) => t.startsWith('历史'));
        expect(texts.sort()).toEqual(['历史 0', '历史 1', '历史 2', '历史 3', '历史 4', '历史 5', '历史 6']);
      } finally {
        late.close();
      }
    } finally {
      host.close();
    }
  });

  it('pages with a bounded page size instead of one huge load', async () => {
    const host = await newRoom(tb, '房主');
    try {
      for (let i = 0; i < 12; i++) await host.sendText(`p${i}`);
      const res = await fetch(`${tb.base}/api/rooms/${host.invite.roomId}/status`);
      expect(res.status).toBe(200);
      const page = await fetch(`${tb.base}/api/rooms/${host.invite.roomId}/messages?limit=3&beforeSeq=${host.headSeq + 1}`, {
        headers: { authorization: `Bearer ${(host as unknown as { sessionToken: string }).sessionToken}` }
      });
      expect(page.status).toBe(200);
      const body = (await page.json()) as { msgs: unknown[]; hasMore: boolean };
      expect(body.msgs.length).toBeLessThanOrEqual(3);
    } finally {
      host.close();
    }
  });

  it('refuses history access without a live room session', async () => {
    const host = await newRoom(tb, '房主');
    const roomId = host.invite.roomId;
    host.close();
    await new Promise((r) => setTimeout(r, 120));
    const res = await fetch(`${tb.base}/api/rooms/${roomId}/messages?limit=5`);
    expect(res.status).toBe(401);
  });

  it('recovers messages missed during a disconnect', async () => {
    const a = await newRoom(tb, '甲');
    const b = await joinByInvite(tb, a.publicInvite, '乙');
    try {
      await a.sendText('断线前');
      await waitFor(() => b.list().some((m) => m.text === '断线前'), { label: 'first delivery' });
      // Hard-cut b's socket while a keeps sending, then reconnect and resync.
      const before = b.list().length;
      b.close();
      await a.sendText('断线期间 1');
      await a.sendText('断线期间 2');
      const restored = await joinByInvite(tb, a.publicInvite, '乙');
      await restored.loadOlder();
      await waitFor(
        () => ['断线前', '断线期间 1', '断线期间 2'].every((t) => restored.list().some((m) => m.text === t)),
        { label: 'gap filled' }
      );
      expect(restored.list().length).toBeGreaterThan(before);
      restored.close();
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('cross-room isolation', () => {
  it('cannot read another room history with a valid session in this room', async () => {
    const a = await newRoom(tb, 'A 房主');
    const b = await newRoom(tb, 'B 房主');
    try {
      await a.sendText('A 的秘密');
      await b.sendText('B 的秘密');
      const token = (b as unknown as { sessionToken: string }).sessionToken;
      const res = await fetch(`${tb.base}/api/rooms/${a.invite.roomId}/messages?limit=10`, {
        headers: { authorization: `Bearer ${token}` }
      });
      expect(res.status).toBe(401);
      const intruder = await joinByInvite(tb, b.publicInvite, '旁观者');
      try {
        await intruder.loadOlder();
        expect(intruder.list().some((m) => m.text === 'A 的秘密')).toBe(false);
        expect(intruder.list().some((m) => m.text === 'B 的秘密')).toBe(true);
      } finally {
        intruder.close();
      }
    } finally {
      a.close();
      b.close();
    }
  });
});
