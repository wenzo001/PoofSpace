import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientOptions,
  joinByInvite,
  makeBytes,
  makeTestbed,
  newRoom,
  recorder,
  scanForPlaintext,
  sliceProvider,
  waitFor,
  type Testbed
} from '../helpers/testbed';
import { RoomClient } from '../../src/lib/client/roomclient';
import { ERR } from '../../src/lib/constants';
import { utf8 } from '../../src/lib/encoding';
import { parseInviteInput } from '../../src/lib/crypto/invite';

let tb: Testbed;

beforeAll(async () => {
  tb = await makeTestbed();
});

afterAll(async () => {
  await tb.cleanup();
});

// ---------------------------------------------------------------- test plumbing

function countSql(sql: string, ...args: (string | number)[]): number {
  const row = tb.srv.db.raw.prepare(sql).get(...args) as { c: number | null };
  return row.c ?? 0;
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countFiles(full);
    else if (entry.isFile()) n++;
  }
  return n;
}

function roomDir(client: RoomClient): string {
  return path.join(tb.roomsDir, client.invite.roomId);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** An upload that parks every chunk worker except the first, so the transfer stays unfinished. */
function gatedUpload(data: Uint8Array, chunkSize: number) {
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  let parked = 0;
  const slice = async (start: number, length: number): Promise<Uint8Array> => {
    const index = Math.floor(start / chunkSize);
    if (index > 0) {
      parked++;
      await gate;
    }
    return data.slice(start, start + length);
  };
  return { slice, parked: () => parked, release: () => releaseGate() };
}

// ------------------------------------------------------------------- round trips

describe('client-side encrypted attachments over the real server', () => {
  it('round-trips a small file byte-identically with its encrypted filename and mime intact', async () => {
    const host = await newRoom(tb, '发送者');
    const peer = await joinByInvite(tb, host.publicInvite, '接收者');
    try {
      const body = utf8('邀请正文\n时间：周三 19:00\n地点：隐蔽处\n');
      const name = '会议邀请函-绝密.txt';
      const uploaded = await host.upload({
        name,
        mime: 'text/plain',
        size: body.length,
        kind: 'file',
        slice: sliceProvider(body)
      });
      expect(uploaded.meta.chunkCount).toBe(1);
      expect(uploaded.meta.name).toBe(name);

      await waitFor(
        () => peer.list().some((m) => m.attachmentId === uploaded.attachmentId),
        { label: 'the file message reaches the peer' }
      );
      const seen = peer.list().find((m) => m.attachmentId === uploaded.attachmentId)!;
      expect(seen.kind).toBe('file');
      expect(seen.state).toBe('sent');
      await waitFor(() => uploaded.msg.state === 'sent', { label: 'ack for the file message' });
      expect(uploaded.msg.seq).toBeGreaterThan(0);

      // The metadata is only readable by a holder of the room key, never by the server.
      const meta = await peer.readMeta(uploaded.attachmentId);
      expect(meta.name).toBe(name);
      expect(meta.mime).toBe('text/plain');
      expect(meta.size).toBe(body.length);
      expect(meta.kind).toBe('file');

      const got = await peer.download(uploaded.attachmentId);
      expect(sameBytes(got, body)).toBe(true);

      // And the server's own view of the same attachment carries no readable name.
      const idx = tb.srv.service.attachmentIndex(host.invite.roomId, uploaded.attachmentId);
      expect(idx).not.toBeNull();
      expect(idx!.totalBytes).toBe(body.length);
      expect(Buffer.from(idx!.meta, 'base64').includes(name, 'utf8')).toBe(false);
    } finally {
      host.close();
      peer.close();
    }
  });

  it('round-trips a multi-chunk file and stores nothing readable in the database or on disk', async () => {
    const host = await newRoom(tb, '发送者');
    const peer = await joinByInvite(tb, host.publicInvite, '接收者');
    try {
      const marker = 'LEAKCHECK-BODY-9F2C';
      const name = 'LEAKCHECK-季度预算-绝密.csv';
      const rows = Array.from({ length: 2000 }, (_, i) => `${marker}|row-${i}|预算 12345678`);
      const body = utf8(rows.join('\n'));
      const chunkSize = 8192;
      const uploaded = await host.upload({
        name,
        mime: 'text/csv',
        size: body.length,
        kind: 'file',
        slice: sliceProvider(body),
        chunkSize,
        concurrency: 4
      });
      expect(uploaded.meta.chunkCount).toBeGreaterThan(1);
      expect(uploaded.meta.chunkCount).toBe(Math.ceil(body.length / chunkSize));

      await waitFor(() => peer.list().some((m) => m.attachmentId === uploaded.attachmentId), {
        label: 'file message delivered'
      });
      const got = await peer.download(uploaded.attachmentId);
      expect(got.length).toBe(body.length);
      expect(sameBytes(got, body)).toBe(true);
      expect(new TextDecoder().decode(got)).toContain(marker);

      // Geometry on the server side: one row and one file per chunk, nothing more.
      const chunkRows = countSql(
        'SELECT COUNT(*) c FROM attachment_chunks k JOIN attachments a ON a.id = k.attachment_id WHERE a.room_id = ?',
        host.invite.roomId
      );
      expect(chunkRows).toBe(uploaded.meta.chunkCount);
      const attDir = path.join(roomDir(host), uploaded.attachmentId);
      expect(fs.readdirSync(attDir).length).toBe(uploaded.meta.chunkCount);

      // No plaintext body and no plaintext filename anywhere under the data directory
      // (this walks the SQLite file, its WAL, and every attachment blob).
      expect(scanForPlaintext(tb.dataDir, [marker, name])).toEqual([]);
    } finally {
      host.close();
      peer.close();
    }
  });

  it('does not let a large in-flight upload block chat, joins or leaves', async () => {
    const host = await newRoom(tb, '发送者');
    const peer = await joinByInvite(tb, host.publicInvite, '接收者');
    const chunkSize = 64 * 1024;
    const chunkCount = 32;
    const body = makeBytes(chunkSize * chunkCount, 7);
    const gate = gatedUpload(body, chunkSize);

    let uploadSettled = false;
    const uploading = host
      .upload({
        name: '大文件.bin',
        mime: 'application/octet-stream',
        size: body.length,
        kind: 'file',
        slice: gate.slice,
        chunkSize,
        concurrency: 3
      })
      .then((r) => {
        uploadSettled = true;
        return r;
      });

    let late: RoomClient | undefined;
    try {
      const landed = () =>
        countSql(
          'SELECT COUNT(*) c FROM attachment_chunks k JOIN attachments a ON a.id = k.attachment_id WHERE a.room_id = ?',
          host.invite.roomId
        );
      // Both halves have to hold at the same instant: chunks 1..n are parked mid-stream and
      // chunk 0 has actually been stored. Reading the row count the moment the gate parks races
      // the server's insert, which is how this leg used to go red without the product changing.
      await waitFor(() => gate.parked() >= 2 && landed() >= 1, {
        label: 'upload parked mid-stream with the first chunk stored'
      });
      // The transfer is genuinely incomplete here, which is what the next three checks measure.
      expect(uploadSettled).toBe(false);
      expect(landed()).toBeLessThan(chunkCount);

      // 1) a real text round trip while the transfer is unfinished
      const t0 = Date.now();
      const mid = await peer.sendText('上传期间也要能说话');
      await waitFor(() => mid.state === 'sent', { timeoutMs: 10_000, label: 'ack during upload' });
      const rttMs = Date.now() - t0;
      expect(rttMs).toBeLessThan(5000);
      expect(mid.seq).toBeGreaterThan(0);
      await waitFor(() => host.list().some((m) => m.clientMsgId === mid.clientMsgId), {
        label: 'the other member sees it'
      });
      expect(uploadSettled).toBe(false);

      // 2) a new member can still join
      late = await joinByInvite(tb, host.publicInvite, '插队者');
      expect(late.status).toBe('open');
      await waitFor(() => tb.srv.service.status(host.invite.roomId).online === 3, {
        label: 'three online'
      });

      // 3) and a member can still leave
      late.close();
      late = undefined;
      await waitFor(() => tb.srv.service.status(host.invite.roomId).online === 2, {
        label: 'departure processed during upload'
      });

      gate.release();
      const uploaded = await uploading;
      expect(uploaded.meta.chunkCount).toBe(chunkCount);
      const got = await peer.download(uploaded.attachmentId);
      expect(sameBytes(got, body)).toBe(true);
    } finally {
      gate.release();
      await uploading.catch(() => undefined);
      host.close();
      peer.close();
      late?.close();
    }
  });

  it('refuses to decrypt a chunk that was tampered with on disk instead of returning corrupt bytes', async () => {
    const host = await newRoom(tb, '发送者');
    const peer = await joinByInvite(tb, host.publicInvite, '接收者');
    try {
      const body = makeBytes(4096 * 5 + 13, 3);
      const uploaded = await host.upload({
        name: 'tamper-target.bin',
        mime: 'application/octet-stream',
        size: body.length,
        kind: 'file',
        slice: sliceProvider(body),
        chunkSize: 4096
      });
      expect(uploaded.meta.chunkCount).toBe(6);
      await waitFor(() => peer.list().some((m) => m.attachmentId === uploaded.attachmentId), {
        label: 'delivery'
      });

      // Control: the pristine attachment does download intact.
      const clean = await peer.download(uploaded.attachmentId);
      expect(sameBytes(clean, body)).toBe(true);

      // Flip one bit inside the ciphertext (past the 12-byte nonce, before the 16-byte tag).
      const chunkPath = tb.srv.storage.chunkPath(host.invite.roomId, uploaded.attachmentId, 2);
      const raw = fs.readFileSync(chunkPath);
      const from = 12;
      const to = raw.length - 16;
      const offset = from + Math.floor((to - from) / 2);
      expect(offset >= from && offset < to).toBe(true);
      const original = raw[offset] as number;
      raw[offset] = original ^ 0x01;
      fs.writeFileSync(chunkPath, raw);
      expect(Buffer.compare(fs.readFileSync(chunkPath), raw)).toBe(0);

      let returned: Uint8Array | undefined;
      let failure: unknown;
      try {
        returned = await peer.download(uploaded.attachmentId);
      } catch (err) {
        failure = err;
      }
      expect(returned).toBeUndefined();
      const err = failure as { name?: string; code?: string; message?: string };
      expect(err.name).toBe('DecryptError');
      expect(err.code).toBe(ERR.decryptFailed);
      expect(String(err.message)).toMatch(/authentication failed/i);

      // Only the tampered chunk is refused; the sealed metadata still opens.
      const meta = await peer.readMeta(uploaded.attachmentId);
      expect(meta.name).toBe('tamper-target.bin');
      // Untouched chunks are still individually readable, so the failure is chunk-scoped.
      const untouched = await fetch(
        `${tb.base}/api/rooms/${host.invite.roomId}/attachments/${uploaded.attachmentId}/chunks/0`,
        { headers: { authorization: `Bearer ${(peer as unknown as { sessionToken: string }).sessionToken}` } }
      );
      expect(untouched.status).toBe(200);

      // A server that cannot forge the tag: the flipped byte is exactly one bit.
      const restored = fs.readFileSync(chunkPath);
      restored[offset] = original;
      fs.writeFileSync(chunkPath, restored);
      const afterRestore = await peer.download(uploaded.attachmentId);
      expect(sameBytes(afterRestore, body)).toBe(true);
    } finally {
      host.close();
      peer.close();
    }
  });

  it('round-trips an image through the same pipeline and leaves it decryptable for a late joiner', async () => {
    const host = await newRoom(tb, '发送者');
    const pngBody = makeBytes(9000, 21);
    try {
      const uploaded = await host.upload({
        name: '屏幕截图.png',
        mime: 'image/png',
        size: pngBody.length,
        kind: 'image',
        slice: sliceProvider(pngBody),
        chunkSize: 4096,
        width: 640,
        height: 480
      });
      await waitFor(() => uploaded.msg.state === 'sent', { label: 'image message acked' });
      expect(uploaded.msg.kind).toBe('image');

      const late = await joinByInvite(tb, host.publicInvite, '后来者');
      try {
        await late.loadOlder();
        await waitFor(() => late.list().some((m) => m.attachmentId === uploaded.attachmentId), {
          label: 'image lands in history'
        });
        const entry = late.list().find((m) => m.attachmentId === uploaded.attachmentId)!;
        expect(entry.kind).toBe('image');
        expect(entry.text).toBe('');
        expect(entry.seq).toBeGreaterThan(0);

        const meta = await late.readMeta(uploaded.attachmentId);
        expect(meta.kind).toBe('image');
        expect(meta.name).toBe('屏幕截图.png');
        expect(meta.mime).toBe('image/png');
        expect(meta.width).toBe(640);
        expect(meta.height).toBe(480);
        expect(meta.chunkCount).toBe(uploaded.meta.chunkCount);

        const got = await late.download(uploaded.attachmentId);
        expect(sameBytes(got, pngBody)).toBe(true);
      } finally {
        late.close();
      }
    } finally {
      host.close();
    }
  });

  it('aborts a failed upload cleanly and a retry leaves exactly one attachment behind', async () => {
    const host = await newRoom(tb, '发送者');
    const peer = await joinByInvite(tb, host.publicInvite, '接收者');
    const chunkSize = 4096;
    const body = makeBytes(chunkSize * 5 + 7, 5);
    try {
      const failing = async (start: number, length: number): Promise<Uint8Array> => {
        const index = Math.floor(start / chunkSize);
        if (index === 3) throw new Error('simulated mid-upload abort');
        return body.slice(start, start + length);
      };
      await expect(
        host.upload({
          name: '半途而废.bin',
          mime: 'application/octet-stream',
          size: body.length,
          kind: 'file',
          slice: failing,
          chunkSize,
          concurrency: 3
        })
      ).rejects.toThrow(/simulated mid-upload abort/);

      // The client's abort path must wipe every trace of the partial transfer.
      await waitFor(
        () => countSql('SELECT COUNT(*) c FROM attachments WHERE room_id = ?', host.invite.roomId) === 0,
        { label: 'abandoned attachment row removed' }
      );
      await waitFor(
        () =>
          countSql(
            'SELECT COUNT(*) c FROM attachment_chunks k JOIN attachments a ON a.id = k.attachment_id WHERE a.room_id = ?',
            host.invite.roomId
          ) === 0,
        { label: 'abandoned chunk rows removed' }
      );
      await waitFor(() => countFiles(roomDir(host)) === 0, { label: 'partial ciphertext deleted' });
      const row = tb.srv.db.raw
        .prepare('SELECT attachment_bytes FROM rooms WHERE id = ?')
        .get(host.invite.roomId) as { attachment_bytes: number };
      expect(row.attachment_bytes).toBe(0);

      // Retry the very same file: one attachment, one set of chunks, no duplicates.
      const retried = await host.upload({
        name: '半途而废.bin',
        mime: 'application/octet-stream',
        size: body.length,
        kind: 'file',
        slice: sliceProvider(body),
        chunkSize,
        concurrency: 3
      });
      await waitFor(() => retried.msg.state === 'sent', { label: 'retried upload acked' });
      expect(
        countSql('SELECT COUNT(*) c FROM attachments WHERE room_id = ?', host.invite.roomId)
      ).toBe(1);
      expect(
        countSql(
          'SELECT COUNT(*) c FROM attachment_chunks k JOIN attachments a ON a.id = k.attachment_id WHERE a.room_id = ?',
          host.invite.roomId
        )
      ).toBe(retried.meta.chunkCount);
      expect(countFiles(roomDir(host))).toBe(retried.meta.chunkCount);

      const got = await peer.download(retried.attachmentId);
      expect(sameBytes(got, body)).toBe(true);

      // And the retried upload is only ever announced once.
      const rec = recorder(peer);
      await host.retry(retried.msg.clientMsgId);
      await new Promise((r) => setTimeout(r, 200));
      // A replayed clientMsgId must not be announced a second time, and the peer must still
      // hold exactly one row for that attachment.
      expect(rec.all().filter((m) => m.attachmentId === retried.attachmentId)).toHaveLength(0);
      expect(peer.list().filter((m) => m.attachmentId === retried.attachmentId)).toHaveLength(1);
    } finally {
      host.close();
      peer.close();
    }
  });

  it('reclaims an upload orphaned by a dead connection, without leaking the room quota', async () => {
    // A short upload TTL so the product's own expiry sweep is reachable inside a test.
    const tb2 = await makeTestbed({ pendingUploadTtlMs: 1200 });
    const previous = tb;
    tb = tb2;
    try {
      const host = await newRoom(tb2, '发送者');
      const peer = await joinByInvite(tb2, host.publicInvite, '接收者');
      const keptBody = makeBytes(5000, 2);
      const kept = await host.upload({
        name: '已完成.bin',
        mime: 'application/octet-stream',
        size: keptBody.length,
        kind: 'file',
        slice: sliceProvider(keptBody),
        chunkSize: 4096
      });
      expect(kept.meta.chunkCount).toBe(2);

      const chunkSize = 64 * 1024;
      const orphanBody = makeBytes(chunkSize * 6, 13);
      const gate = gatedUpload(orphanBody, chunkSize);
      let settled = false;
      const uploading = host
        .upload({
          name: '断线残留.bin',
          mime: 'application/octet-stream',
          size: orphanBody.length,
          kind: 'file',
          slice: gate.slice,
          chunkSize,
          concurrency: 2
        })
        .then((r) => {
          settled = true;
          return r;
        });
      await waitFor(() => gate.parked() >= 1, { label: 'upload parked' });
      expect(settled).toBe(false);

      // The uploader dies mid-transfer: the session is revoked, so the remaining
      // chunks must be refused rather than silently accepted.
      host.close();
      gate.release();
      await expect(uploading).rejects.toThrow(/401/);

      const roomId = host.invite.roomId;
      expect(countSql('SELECT COUNT(*) c FROM attachments WHERE room_id = ?', roomId)).toBe(2);

      // Past the reservation TTL the server discards the abandoned upload...
      await new Promise((r) => setTimeout(r, 1500));
      expect(tb2.srv.service.sweepExpiredAttachments()).toBe(1);
      await waitFor(() => countFiles(path.join(tb2.roomsDir, roomId)) === 2, {
        label: 'orphaned ciphertext deleted'
      });
      expect(
        countSql('SELECT COUNT(*) c FROM attachments WHERE room_id = ? AND state = ?', roomId, 'READY')
      ).toBe(1);
      // ...and the survivor still decrypts.
      const stillThere = await peer.download(kept.attachmentId);
      expect(sameBytes(stillThere, keptBody)).toBe(true);

      // A rejoiner retrying the same file leaves exactly one more attachment, no duplicates.
      const rejoiner = await joinByInvite(tb2, host.publicInvite, '重试者');
      const retried = await rejoiner.upload({
        name: '断线残留.bin',
        mime: 'application/octet-stream',
        size: orphanBody.length,
        kind: 'file',
        slice: sliceProvider(orphanBody),
        chunkSize: 1024 * 1024
      });
      await waitFor(() => retried.msg.state === 'sent', { label: 'retry acked' });
      expect(
        countSql('SELECT COUNT(*) c FROM attachments WHERE room_id = ?', roomId)
      ).toBe(2);
      expect(countFiles(path.join(tb2.roomsDir, roomId))).toBe(2 + retried.meta.chunkCount);

      // Quota hygiene: the room's accounted attachment bytes must equal the sum of the
      // attachments it actually still stores — an expired upload must not keep charging it.
      const accounted = (
        tb2.srv.db.raw.prepare('SELECT attachment_bytes FROM rooms WHERE id = ?').get(roomId) as {
          attachment_bytes: number;
        }
      ).attachment_bytes;
      const stored = (
        tb2.srv.db.raw
          .prepare('SELECT COALESCE(SUM(total_bytes), 0) c FROM attachments WHERE room_id = ?')
          .get(roomId) as { c: number }
      ).c;
      expect(accounted).toBe(stored);

      rejoiner.close();
      peer.close();
    } finally {
      tb = previous;
      await tb2.cleanup();
    }
  });

  it('refuses an upload reservation from a member who is not in the room', async () => {
    const host = await newRoom(tb, '发送者');
    const outsider = RoomClient.fromSecret(
      clientOptions(tb),
      { roomId: host.invite.roomId, secret: new Uint8Array(32).fill(4) },
      '外人'
    );
    try {
      await expect(outsider.connect()).rejects.toThrow(ERR.badProof);
      const body = utf8('x');
      await expect(
        host.upload({
          name: 'ok.bin',
          mime: 'application/octet-stream',
          size: body.length,
          kind: 'file',
          slice: sliceProvider(body)
        })
      ).resolves.toMatchObject({ meta: { chunkCount: 1 } });
    } finally {
      outsider.close();
      host.close();
    }
  });

  it('rejects an attachment whose declared size does not fit its chunk geometry', async () => {
    const host = await newRoom(tb, '发送者');
    const peer = await joinByInvite(tb, host.publicInvite, '接收者');
    try {
      // The reservation claims 3 chunks of 1 KiB but only ever sends 2.
      const body = makeBytes(2048, 8);
      const attachmentId = 'f'.repeat(32);
      const sealedMeta = await import('../../src/lib/crypto/envelope').then((m) =>
        m.sealMeta(
          (host as unknown as { keys: { metaKey: Uint8Array } }).keys.metaKey,
          host.invite.roomId,
          attachmentId,
          { name: '缺口.bin', mime: 'application/octet-stream', size: 2048, chunkSize: 1024, chunkCount: 3, kind: 'file' as const }
        )
      );
      const token = (host as unknown as { sessionToken: string }).sessionToken;
      (host as unknown as {
        sendFrame(f: unknown): void;
      }).sendFrame({
        t: 'upload:create',
        attachmentId,
        chunkSize: 1024,
        chunkCount: 3,
        totalBytes: 2048,
        meta: Buffer.from(sealedMeta.ct).toString('base64'),
        metaNonce: Buffer.from(sealedMeta.nonce).toString('base64'),
        kind: 'file'
      });
      await new Promise((r) => setTimeout(r, 150));
      for (const index of [0, 1]) {
        const frame = await import('../../src/lib/crypto/envelope').then((m) =>
          m.sealChunk(
            (host as unknown as { keys: { fileKey: Uint8Array } }).keys.fileKey,
            { slot: (host as unknown as { slot: number }).slot, gen: (host as unknown as { gen: number }).gen },
            index + 1,
            host.invite.roomId,
            attachmentId,
            index,
            body.subarray(index * 1024, index * 1024 + 1024)
          )
        );
        const put = await fetch(
          `${tb.base}/api/rooms/${host.invite.roomId}/uploads/${attachmentId}/chunks/${index}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
            body: frame as unknown as BodyInit
          }
        );
        expect(put.status).toBe(200);
      }
      const complete = await fetch(
        `${tb.base}/api/rooms/${host.invite.roomId}/uploads/${attachmentId}/complete`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` } }
      );
      expect(complete.status).toBe(400);
      const detail = (await complete.json()) as { error: string };
      expect(detail.error).toBe(ERR.badState);
      // Never marked READY, so no member can download a truncated "complete" file.
      const idx = tb.srv.service.attachmentIndex(host.invite.roomId, attachmentId);
      expect(idx!.complete).toBe(false);
      await expect(peer.download(attachmentId)).rejects.toThrow(/unavailable/);
      expect(
        countSql('SELECT COUNT(*) c FROM attachments WHERE room_id = ? AND state = ?', host.invite.roomId, 'READY')
      ).toBe(0);
    } finally {
      host.close();
      peer.close();
    }
  });

  it('keeps attachments out of reach of a member of another room', async () => {
    const a = await newRoom(tb, 'A 房主');
    const b = await newRoom(tb, 'B 房主');
    const bPeer = await joinByInvite(tb, b.publicInvite, 'B 成员');
    try {
      const body = utf8('A 房附件内容 MARKER-A-ATT');
      const uploaded = await a.upload({
        name: 'a-secret.bin',
        mime: 'application/octet-stream',
        size: body.length,
        kind: 'file',
        slice: sliceProvider(body)
      });
      const bToken = (bPeer as unknown as { sessionToken: string }).sessionToken;
      const probe = await fetch(
        `${tb.base}/api/rooms/${b.invite.roomId}/attachments/${uploaded.attachmentId}`,
        { headers: { authorization: `Bearer ${bToken}` } }
      );
      // B's token is valid for B's room, and the id simply does not exist there: a refusal
      // that does not confirm the attachment belongs to some other room.
      expect(probe.status).toBe(404);
      expect(((await probe.json()) as { error: string }).error).toBe(ERR.attachmentNotFound);
      const wrongRoom = await fetch(
        `${tb.base}/api/rooms/${a.invite.roomId}/attachments/${uploaded.attachmentId}`,
        { headers: { authorization: `Bearer ${bToken}` } }
      );
      expect(wrongRoom.status).toBe(401);
      const got = await bPeer.download(uploaded.attachmentId).catch((e: Error) => e.message);
      expect(String(got)).toMatch(/unavailable|authentication failed/);
    } finally {
      a.close();
      b.close();
      bPeer.close();
    }
  });
});
