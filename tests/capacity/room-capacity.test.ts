import { describe, expect, it } from 'vitest';
import { join, makeSandbox, seedRoom, appendText } from '../helpers/sandbox';
import { ERR, LIMITS } from '../../src/lib/constants';
import { loadConfig } from '../../src/server/config';
import { RoomClient } from '../../src/lib/client/roomclient';
import { joinByInvite, makeTestbed, newRoom, openSocket, waitFor, clientOptions, type Testbed } from '../helpers/testbed';
import { randomBytes } from '../../src/lib/encoding';
import { encodeRoomId } from '../../src/lib/crypto/invite';
import { computeJoinProof } from '../../src/lib/crypto/keys';

/**
 * Capacity is a server-side promise, so it is measured server-side: the ledger is the rooms
 * table, the allocation happens inside the same transaction as the insert, and a refusal says
 * nothing that would help anyone count what the node is holding.
 */

type Sbx = ReturnType<typeof makeSandbox>;

const roomId = () => encodeRoomId(randomBytes(16));

describe('node-wide room capacity', () => {
  it('1. ships MAX_ROOMS 20 and every limit is read from the environment', () => {
    expect(LIMITS.maxRoomsDefault).toBe(20);
    expect(LIMITS.roomIdleTtlSeconds).toBe(300);
    expect(LIMITS.maxMembersDefault).toBe(100);
    expect(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).maxRooms).toBe(20);
    expect(loadConfig({ NODE_ENV: 'test', MAX_ROOMS: '7', ROOM_IDLE_TTL_SECONDS: '45', MAX_PARTICIPANTS_PER_ROOM: '30' } as NodeJS.ProcessEnv)).toMatchObject({
      maxRooms: 7,
      roomIdleTtlMs: 45_000,
      maxMembersDefault: 30
    });
  });

  it('2. refuses to boot on a capacity number that cannot be honoured', () => {
    // A typo must stop the process, not silently run a node with no ceiling or an unusable window.
    expect(() => loadConfig({ NODE_ENV: 'test', MAX_ROOMS: '0' } as NodeJS.ProcessEnv)).toThrow(/MAX_ROOMS/);
    expect(() => loadConfig({ NODE_ENV: 'test', MAX_ROOMS: 'many' } as NodeJS.ProcessEnv)).toThrow(/MAX_ROOMS/);
    expect(() => loadConfig({ NODE_ENV: 'test', MAX_ROOMS: '100000' } as NodeJS.ProcessEnv)).toThrow(/MAX_ROOMS/);
    expect(() => loadConfig({ NODE_ENV: 'test', ROOM_IDLE_TTL_SECONDS: '5' } as NodeJS.ProcessEnv)).toThrow(/ROOM_IDLE_TTL_SECONDS/);
    expect(() => loadConfig({ NODE_ENV: 'test', MAX_PARTICIPANTS_PER_ROOM: '501' } as NodeJS.ProcessEnv)).toThrow(
      /MAX_PARTICIPANTS_PER_ROOM/
    );
    expect(() => loadConfig({ NODE_ENV: 'test', MAX_CONNECTIONS_NODE: '-1' } as NodeJS.ProcessEnv)).toThrow(/MAX_CONNECTIONS_NODE/);
  });

  it('3. counts ACTIVE, IDLE_GRACE and DESTROYING rooms, and frees the slot only when cleanup finished', async () => {
    const sbx = makeSandbox({ maxRooms: 3 });
    try {
      const a = seedRoom(sbx);
      const b = seedRoom(sbx);
      const c = seedRoom(sbx);
      expect(sbx.service.slotsHeld()).toBe(3);

      const full = sbx.service.createRoom(roomId(), randomBytes(32), 100);
      expect(full.ok).toBe(false);
      if (!full.ok) expect(full.code).toBe(ERR.capacityFull);

      // Emptying a room does not hand its slot back: the recovery window still owns it.
      const aMember = join(sbx, a);
      sbx.service.leave(a.roomId, aMember.slot, aMember.gen);
      expect(sbx.service.status(a.roomId).status).toBe('IDLE_GRACE');
      expect(sbx.service.slotsHeld()).toBe(3);

      // Destroying it holds the slot until the last byte is verifiably gone.
      const storage = sbx.storage as unknown as { removeRoom: (id: string) => Promise<{ files: number; bytes: number }> };
      const realRemove = storage.removeRoom.bind(storage);
      storage.removeRoom = async () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      };
      await sbx.service.destroy(a.roomId, 'creator', a.creatorToken);
      expect(sbx.service.slotsHeld()).toBe(3);

      storage.removeRoom = realRemove;
      // The scheduled retry, not a second request, is what finishes the job: the room stays in
      // DESTROYING (and keeps its slot) until the cleanup proves itself.
      sbx.service.tick(Date.now() + sbx.cfg.destroyRetryMs + 1);
      await new Promise((r) => setTimeout(r, 150));
      expect(sbx.service.status(a.roomId).status).toBe('UNKNOWN');
      expect(sbx.service.pendingDestroys()).toEqual([]);
      expect(sbx.service.slotsHeld()).toBe(2);

      const fourth = sbx.service.createRoom(roomId(), randomBytes(32), 100);
      expect(fourth.ok).toBe(true);
      expect(b.roomId).not.toBe(c.roomId);
    } finally {
      sbx.close();
    }
  });

  it('4. concurrent creates cannot walk past the cap', async () => {
    const tb = await makeTestbed({ maxRooms: 5 });
    try {
      const results = await Promise.all(
        Array.from({ length: 9 }, async () => {
          const id = encodeRoomId(randomBytes(16));
          const res = await fetch(`${tb.base}/api/rooms`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ roomId: id, joinKey: Buffer.from(randomBytes(32)).toString('base64url') })
          });
          return res.status;
        })
      );
      expect(results.filter((s) => s === 201)).toHaveLength(5);
      expect(results.filter((s) => s === 503)).toHaveLength(4);
      expect(tb.srv.service.slotsHeld()).toBe(5);
      expect((tb.srv.db.raw.prepare('SELECT COUNT(*) c FROM rooms').get() as { c: number }).c).toBe(5);
    } finally {
      await tb.cleanup();
    }
  });

  it('5. a refusal says nothing about how full the node is, and there is no room list to read', async () => {
    const tb = await makeTestbed({ maxRooms: 1 });
    const host = await newRoom(tb, '房主');
    try {
      const id = encodeRoomId(randomBytes(16));
      const res = await fetch(`${tb.base}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: id, joinKey: Buffer.from(randomBytes(32)).toString('base64url') })
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe(ERR.capacityFull);
      // No counts, no ids: a caller learns that it must wait, not what the node is holding.
      expect(body.message).not.toMatch(/\d/);
      expect(JSON.stringify(body)).not.toContain(host.publicInvite.roomId);

      const list = await fetch(`${tb.base}/api/rooms`, { method: 'GET' });
      expect(list.status).toBe(404);
      const listed = (await list.json()) as { error: string };
      expect(listed.error).toBe('NOT_FOUND');
    } finally {
      host.close();
      await tb.cleanup();
    }
  });

  it('6. caps members at the operator number, and one member cannot hoard uploads', () => {
    const sbx = makeSandbox({ maxMembersDefault: 2, tempBytesMaxNode: 1024 });
    try {
      const room = seedRoom(sbx, 5);
      // The client asked for 5; the operator's MAX_PARTICIPANTS_PER_ROOM is the ceiling.
      expect(sbx.db.raw.prepare('SELECT max_members FROM rooms').get()).toMatchObject({ max_members: 2 });
      const first = join(sbx, room, '甲');
      join(sbx, room, '乙', 1);

      const bogus = sbx.service.join(
        { roomId: room.roomId, proof: randomBytes(32), nick: new Uint8Array(1), nickNonce: randomBytes(12) },
        randomBytes(32)
      );
      // The proof is checked before the cap, so a stranger cannot learn that the room is full.
      expect(bogus.code).toBe(ERR.badProof);

      const challenge = room.challenge.slice();
      challenge[0] = (challenge[0] as number) + 9;
      const full = sbx.service.join(
        {
          roomId: room.roomId,
          proof: computeJoinProof(room.keys.joinKey, room.roomId, challenge),
          nick: new Uint8Array(1),
          nickNonce: randomBytes(12)
        },
        challenge
      );
      expect(full.ok).toBe(false);
      expect(full.code).toBe(ERR.roomFull);

      // Free one seat, then use it: the upload-hoarding check needs a member in the room.
      sbx.service.leave(room.roomId, first.slot, first.gen);
      const who = join(sbx, room, '丙', 2);
      for (let i = 0; i < LIMITS.pendingUploadsPerMember; i++) {
        const res = sbx.service.createAttachment({
          roomId: room.roomId,
          slot: who.slot,
          gen: who.gen,
          attachmentId: `0000000000000000000000000000000${i}`,
          chunkSize: 64,
          chunkCount: 1,
          totalBytes: 32,
          meta: new Uint8Array(1),
          metaNonce: randomBytes(12),
          kind: 'file'
        });
        expect(res.ok, `reservation ${i}`).toBe(true);
      }
      const greedy = sbx.service.createAttachment({
        roomId: room.roomId,
        slot: who.slot,
        gen: who.gen,
        attachmentId: '0000000000000000000000000000000z',
        chunkSize: 64,
        chunkCount: 1,
        totalBytes: 32,
        meta: new Uint8Array(1),
        metaNonce: randomBytes(12),
        kind: 'file'
      });
      expect(greedy.ok).toBe(false);
      expect(greedy.code).toBe(ERR.rateLimited);
    } finally {
      sbx.close();
    }
  });

  it('7. the node-wide temp quota stops uploads before the disk does', () => {
    const sbx = makeSandbox({ tempBytesMaxNode: 100 });
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const res = sbx.service.createAttachment({
        roomId: room.roomId,
        slot: who.slot,
        gen: who.gen,
        attachmentId: 'a'.repeat(32),
        chunkSize: 1024,
        chunkCount: 1,
        totalBytes: 96,
        meta: new Uint8Array(1),
        metaNonce: randomBytes(12),
        kind: 'file'
      });
      expect(res.ok).toBe(true);
      const second = sbx.service.createAttachment({
        roomId: room.roomId,
        slot: who.slot,
        gen: who.gen,
        attachmentId: 'b'.repeat(32),
        chunkSize: 1024,
        chunkCount: 1,
        totalBytes: 96,
        meta: new Uint8Array(1),
        metaNonce: randomBytes(12),
        kind: 'file'
      });
      expect(second.ok).toBe(false);
      expect(second.code).toBe(ERR.storageFull);
    } finally {
      sbx.close();
    }
  });

  it('8. refuses WebSocket upgrades past the connection ceilings', async () => {
    // Both gates get their own refusal: the node-wide one and the per-address one are separate
    // conditions, and a leg that only ever trips one of them says nothing about the other.
    const cases: { connectionsNodeMax?: number; connectionsPerIpMax?: number }[] = [
      { connectionsNodeMax: 2 },
      { connectionsPerIpMax: 2 }
    ];
    for (const cfg of cases) {
      const box = await makeTestbed({ ...cfg, connectionsNodeMax: cfg.connectionsNodeMax ?? 1000, connectionsPerIpMax: cfg.connectionsPerIpMax ?? 1000 });
      const sockets: import('ws').WebSocket[] = [];
      try {
        for (let i = 0; i < 2; i++) {
          const ws = openSocket(`${box.base.replace('http', 'ws')}/ws`);
          sockets.push(ws as unknown as import('ws').WebSocket);
          await waitFor(() => ws.readyState === 1, { label: `socket ${i} open` });
        }
        const refused = await new Promise<{ rejected: boolean; status: number | null }>((resolve) => {
          const ws = new (require('ws').WebSocket)(`${box.base.replace('http', 'ws')}/ws`);
          // `unexpected-response` is what the client library emits for a real HTTP answer to an
          // upgrade request: a hang would never fire it, so a green here means an actual refusal.
          ws.on('unexpected-response', (_req: unknown, res: { statusCode: number }) =>
            resolve({ rejected: res.statusCode === 503, status: res.statusCode })
          );
          ws.on('open', () => resolve({ rejected: false, status: null }));
          ws.on('error', () => resolve({ rejected: false, status: null }));
        });
        expect(refused.rejected, JSON.stringify(cfg)).toBe(true);
        expect(refused.status).toBe(503);
        expect(box.srv.hub.totalConnections()).toBe(2);
      } finally {
        for (const ws of sockets) ws.terminate();
        await box.cleanup();
      }
    }
  });

  it('9. a room id is a locator, never an authorisation: no cross-room read', async () => {
    const sbx = makeSandbox();
    try {
      const a = seedRoom(sbx);
      const b = seedRoom(sbx);
      const aWho = join(sbx, a, '甲');
      const bWho = join(sbx, b, '乙');
      // A session minted for one room is worthless against another id, in both directions.
      expect(sbx.service.authorizeToken(aWho.sessionToken, b.roomId)).toBeNull();
      expect(sbx.service.authorizeToken(bWho.sessionToken, a.roomId)).toBeNull();
      expect(sbx.service.attachmentIndex(b.roomId, 'a'.repeat(32))).toBeNull();
      // authorizeToken is what the HTTP layer calls before serving any read or upload, so a
      // foreign room id has nothing to hand out. (The socket path cannot name another room at
      // all: the room id of a frame is the one the connection joined, never the one it typed.)
      const before = sbx.service.headSeq(b.roomId);
      await appendText(sbx, a, aWho, '只在 A 里的一句话', { n: 0 });
      expect(sbx.service.headSeq(b.roomId)).toBe(before);
      expect(sbx.service.history(b.roomId).msgs).toEqual([]);
      // B's history is empty for everyone who is not B's member.
      expect(sbx.service.history(b.roomId).msgs).toEqual([]);
    } finally {
      sbx.close();
    }
  });
});
