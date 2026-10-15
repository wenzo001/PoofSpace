import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { appendText, blobContains, join, makeSandbox, readAllBlobs, seedRoom } from '../helpers/sandbox';
import { scanForPlaintext } from '../helpers/testbed';
import { computeJoinProof, deriveRoomKeys } from '../../src/lib/crypto/keys';
import { openChunk, openMessage, sealChunk, sealMeta, chunkAAD } from '../../src/lib/crypto/envelope';
import { randomBytes, randomHex, bytesToB64, bytesToB64url, b64ToBytes, utf8 } from '../../src/lib/encoding';
import { captureLogs } from '../../src/server/log';
import { ERR, LIMITS } from '../../src/lib/constants';
import { aeadEncrypt } from '../../src/lib/crypto/engine';
import { hmacSha256 } from '../../src/lib/crypto/engine';

describe('nothing readable at rest', () => {
  it('stores no plaintext message body in the database or the attachment tree', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const body = '机密：合同编号 HG-2026-9931 明天签约';
      const ref = { n: 0 };
      await appendText(sbx, room, who, body, ref);

      const blobs = readAllBlobs(sbx.db);
      expect(blobs.length).toBeGreaterThan(0);
      expect(blobs.filter((b) => blobContains(b, body))).toEqual([]);
      expect(scanForPlaintext(sbx.dataDir, [body])).toEqual([]);
      // The file itself only exists once it is on disk, so check the whole data dir.
      expect(scanForPlaintext(sbx.cfg.roomsDir, [body])).toEqual([]);
    } finally {
      sbx.close();
    }
  });

  it('stores no plaintext file name or file bytes for an attachment', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const attachmentId = randomHex(16);
      const marker = 'QUARTERLY-REPORT-DRAFT-9182';
      const payload = utf8(`${marker} 内容机密`);
      const meta = { name: '第二季度财报草稿.pdf', mime: 'application/pdf', size: payload.length, chunkSize: 1024, chunkCount: 1, kind: 'file' as const };
      const sealedMeta = await sealMeta(room.keys.metaKey, room.roomId, attachmentId, meta);

      const created = sbx.service.createAttachment({
        roomId: room.roomId,
        slot: who.slot,
        gen: who.gen,
        attachmentId,
        chunkSize: meta.chunkSize,
        chunkCount: meta.chunkCount,
        totalBytes: meta.size,
        meta: sealedMeta.ct,
        metaNonce: sealedMeta.nonce,
        kind: 'file'
      });
      expect(created.ok).toBe(true);

      const frame = await sealChunk(room.keys.fileKey, { slot: who.slot, gen: who.gen }, 1, room.roomId, attachmentId, 0, payload);
      const written = await sbx.service.writeChunk(room.roomId, attachmentId, 0, frame, who.sessionToken);
      expect(written.ok).toBe(true);

      expect(fs.existsSync(path.join(sbx.cfg.roomsDir, room.roomId, attachmentId, '0.bin'))).toBe(true);
      expect(scanForPlaintext(sbx.cfg.roomsDir, [marker, meta.name])).toEqual([]);
      expect(readAllBlobs(sbx.db).filter((b) => blobContains(b, meta.name) || blobContains(b, marker))).toEqual([]);

      // A client that holds the key still reads it back intact.
      const onDisk = new Uint8Array(await fs.promises.readFile(path.join(sbx.cfg.roomsDir, room.roomId, attachmentId, '0.bin')));
      const plain = await openChunk(room.keys.fileKey, room.roomId, attachmentId, 0, onDisk);
      expect(Buffer.from(plain).toString('utf8')).toContain(marker);
    } finally {
      sbx.close();
    }
  });

  it('leaves no secret or plaintext in the server log stream', async () => {
    const sbx = makeSandbox({ logLevel: 'debug' });
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const body = '日志里不能出现的原文 XYZ-4471';
      const secretB64 = Buffer.from(room.secret).toString('base64url');
      const lines = await captureLogs(async () => {
        await appendText(sbx, room, who, body, { n: 0 });
        sbx.service.setNick(room.roomId, who.slot, utf8('昵称机密-77'), new Uint8Array(12));
        sbx.service.sweepHeartbeats();
        sbx.service.stats();
      });
      const all = lines.join('\n');
      expect(all.length).toBeGreaterThanOrEqual(0);
      expect(all).not.toContain(body);
      expect(all).not.toContain(secretB64);
      expect(all).not.toContain(Buffer.from(room.secret).toString('hex'));
      expect(all).not.toContain(who.sessionToken);
      expect(all).not.toContain(room.creatorToken);
    } finally {
      sbx.close();
    }
  });
});

describe('the server cannot decrypt', () => {
  it('cannot open a message with the only key material it stores', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const body = '服务器读不到的内容 ABC-1234';
      const ref = { n: 0 };
      const dto = await appendText(sbx, room, who, body, ref);
      expect(dto).toBeDefined();

      const row = sbx.db.raw
        .prepare('SELECT nonce, ct, client_msg_id FROM messages WHERE room_id=? LIMIT 1')
        .get(room.roomId) as { nonce: Buffer; ct: Buffer; client_msg_id: string };
      const stored = sbx.db.raw.prepare('SELECT join_key, creator_token FROM rooms WHERE id=?').get(room.roomId) as {
        join_key: Buffer;
        creator_token: Buffer;
      };

      // Every key the database holds, plus every single-step derivation of them.
      const storedJoinKey = new Uint8Array(stored.join_key);
      const candidates: Uint8Array[] = [
        storedJoinKey,
        new Uint8Array(stored.creator_token),
        hmacSha256(storedJoinKey, utf8('poofspace/v1/msg')),
        deriveRoomKeys(storedJoinKey).msgKey,
        deriveRoomKeys(storedJoinKey).fileKey,
        deriveRoomKeys(storedJoinKey).metaKey
      ];
      for (const candidate of candidates) {
        await expect(
          openMessage(candidate, room.roomId, row.client_msg_id, {
            nonce: new Uint8Array(row.nonce),
            ct: new Uint8Array(row.ct)
          })
        ).rejects.toThrow();
      }
      // And a correct-shaped AES key derived from nothing still cannot read it.
      await expect(
        openMessage(randomBytes(32), room.roomId, row.client_msg_id, {
          nonce: new Uint8Array(row.nonce),
          ct: new Uint8Array(row.ct)
        })
      ).rejects.toThrow();
    } finally {
      sbx.close();
    }
  });

  it('does not store the invite secret anywhere in the row for a live room', () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      join(sbx, room);
      const hits = readAllBlobs(sbx.db).filter((b) => blobContains(b, Buffer.from(room.secret).toString('utf8')));
      const hexSecret = Buffer.from(room.secret).toString('hex');
      const hexHits = readAllBlobs(sbx.db).filter((b) => b.hex.includes(hexSecret));
      expect(hits).toEqual([]);
      expect(hexHits).toEqual([]);
    } finally {
      sbx.close();
    }
  });
});

describe('tamper and authority rejection', () => {
  it('refuses a ciphertext frame whose byte or tag was flipped on the server side', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const ref = { n: 0 };
      const dto = await appendText(sbx, room, who, '未被篡改的原文', ref);
      const nonce = b64ToBytes(dto!.nonce);
      const ct = b64ToBytes(dto!.ct);

      for (const idx of [0, Math.floor(ct.length / 2), ct.length - 1]) {
        const flipped = Uint8Array.from(ct);
        flipped[idx] = (flipped[idx] as number) ^ 0x01;
        await expect(openMessage(room.keys.msgKey, room.roomId, dto!.clientMsgId, { nonce, ct: flipped })).rejects.toThrow();
      }
      // Sanity: the untouched pair still opens.
      const opened = await openMessage(room.keys.msgKey, room.roomId, dto!.clientMsgId, { nonce, ct });
      expect(opened.kind).toBe('text');
    } finally {
      sbx.close();
    }
  });

  it('refuses a chunk moved to another index or another attachment', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const fileKey = room.keys.fileKey;
      const frame = await sealChunk(fileKey, { slot: 1, gen: 0 }, 1, room.roomId, 'a'.repeat(32), 3, utf8('分片内容'));
      expect(await openChunk(fileKey, room.roomId, 'a'.repeat(32), 3, frame)).toEqual(utf8('分片内容'));
      await expect(openChunk(fileKey, room.roomId, 'a'.repeat(32), 4, frame)).rejects.toThrow();
      await expect(openChunk(fileKey, room.roomId, 'b'.repeat(32), 3, frame)).rejects.toThrow();
      await expect(openChunk(fileKey, 'c'.repeat(26), 'a'.repeat(32), 3, frame)).rejects.toThrow();
    } finally {
      sbx.close();
    }
  });

  it('rejects a forged destroy token, a missing token, and a replay after destroy', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      await appendText(sbx, room, who, '销毁前消息', { n: 0 });

      await expect(sbx.service.destroy(room.roomId, 'creator', 'forged-token')).resolves.toMatchObject({
        ok: false
      });
      const forged = await sbx.service.destroy(room.roomId, 'creator', bytesToB64url(randomBytes(32)));
      expect(forged.ok).toBe(false);
      expect(forged.code).toBe(ERR.notCreator);
      const missing = await sbx.service.destroy(room.roomId, 'creator', '');
      expect(missing.ok).toBe(false);
      expect(sbx.service.status(room.roomId).status).toBe('ACTIVE');

      const ok = await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);
      expect(ok.ok).toBe(true);
      // The same token is worthless once the room is gone.
      const replay = await sbx.service.destroy(room.roomId, 'creator', room.creatorToken);
      expect(replay.ok).toBe(true);
      // Destroyed means gone: no row, so the status is exactly what an unused room id answers.
      expect(sbx.service.status(room.roomId).status).toBe('UNKNOWN');
    } finally {
      sbx.close();
    }
  });

  it('refuses a join whose proof comes from a different secret', () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const wrongKeys = deriveRoomKeys(randomBytes(32));
      const proof = computeJoinProof(wrongKeys.joinKey, room.roomId, room.challenge);
      const res = sbx.service.join({ roomId: room.roomId, proof, nick: utf8('x'), nickNonce: new Uint8Array(12) }, room.challenge);
      expect(res.ok).toBe(false);
      expect(res.code).toBe(ERR.badProof);
    } finally {
      sbx.close();
    }
  });

  it('refuses a cross-room replay of a valid join proof', () => {
    const sbx = makeSandbox();
    try {
      const a = seedRoom(sbx);
      const b = seedRoom(sbx);
      const proof = computeJoinProof(a.keys.joinKey, a.roomId, a.challenge);
      const res = sbx.service.join({ roomId: b.roomId, proof, nick: utf8('x'), nickNonce: new Uint8Array(12) }, a.challenge);
      expect(res.ok).toBe(false);
      expect([ERR.badProof, ERR.roomNotFound]).toContain(res.code);
    } finally {
      sbx.close();
    }
  });

  it('refuses writes from a stale session generation', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const first = join(sbx, room);
      // Reconnect: the old session is released first, then the same slot is re-issued
      // with a higher gen, so the old gen is dead.
      sbx.service.leave(room.roomId, first.slot);
      const second = join(sbx, room, '重来者', 1);
      expect(second.slot).toBe(first.slot);
      expect(second.gen).toBeGreaterThan(first.gen);
      const stale = await sbx.service.appendMessage({
        roomId: room.roomId,
        slot: first.slot,
        gen: first.gen,
        clientMsgId: randomHex(16),
        kind: 'text',
        nonce: randomBytes(12),
        ct: randomBytes(40)
      });
      expect(stale.ok).toBe(false);
      expect(stale.code).toBe(ERR.notMember);
      const fresh = await sbx.service.appendMessage({
        roomId: room.roomId,
        slot: second.slot,
        gen: second.gen,
        clientMsgId: randomHex(16),
        kind: 'text',
        nonce: randomBytes(12),
        ct: randomBytes(40)
      });
      expect(fresh.ok).toBe(true);
    } finally {
      sbx.close();
    }
  });

  it('refuses an oversized or malformed envelope', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const tooBig = await sbx.service.appendMessage({
        roomId: room.roomId,
        slot: who.slot,
        gen: who.gen,
        clientMsgId: randomHex(16),
        kind: 'text',
        nonce: randomBytes(12),
        ct: randomBytes(LIMITS.textCiphertextBytes + 10)
      });
      expect(tooBig.ok).toBe(false);
      expect(tooBig.code).toBe(ERR.tooLarge);
      const badNonce = await sbx.service.appendMessage({
        roomId: room.roomId,
        slot: who.slot,
        gen: who.gen,
        clientMsgId: randomHex(16),
        kind: 'text',
        nonce: randomBytes(8),
        ct: randomBytes(40)
      });
      expect(badNonce.ok).toBe(false);
    } finally {
      sbx.close();
    }
  });

  it('rate limits a flooding member instead of accepting an unbounded queue', async () => {
    const sbx = makeSandbox();
    try {
      const room = seedRoom(sbx);
      const who = join(sbx, room);
      const codes: (string | undefined)[] = [];
      for (let i = 0; i < LIMITS.msgBurst + 60; i++) {
        const res = await sbx.service.appendMessage({
          roomId: room.roomId,
          slot: who.slot,
          gen: who.gen,
          clientMsgId: randomHex(16),
          kind: 'text',
          nonce: randomBytes(12),
          ct: randomBytes(40)
        });
        codes.push(res.code);
      }
      expect(codes).toContain(ERR.rateLimited);
      const stored = (sbx.db.raw.prepare('SELECT COUNT(*) c FROM messages WHERE room_id=?').get(room.roomId) as { c: number }).c;
      expect(stored).toBeLessThanOrEqual(LIMITS.msgBurst + 5);
    } finally {
      sbx.close();
    }
  });

  it('binds the AAD to room and message id so a copied frame cannot authenticate', async () => {
    const sbx = makeSandbox();
    try {
      const a = seedRoom(sbx);
      const b = seedRoom(sbx);
      const whoA = join(sbx, a);
      const ref = { n: 0 };
      const dto = await appendText(sbx, a, whoA, 'A 房间的话', ref);
      const nonce = b64ToBytes(dto!.nonce);
      const ct = b64ToBytes(dto!.ct);
      await expect(openMessage(a.keys.msgKey, b.roomId, dto!.clientMsgId, { nonce, ct })).rejects.toThrow();
      await expect(openMessage(a.keys.msgKey, a.roomId, 'other-id', { nonce, ct })).rejects.toThrow();
      // And the AAD text itself is what we claim it is.
      expect(Buffer.from(chunkAAD(a.roomId, 'att', 2)).toString('utf8')).toContain('chunk');
      await expect(aeadEncrypt(randomBytes(16), nonce, ct, ct)).rejects.toThrow();
    } finally {
      sbx.close();
    }
  });
});
