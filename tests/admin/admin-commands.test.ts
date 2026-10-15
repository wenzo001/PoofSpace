import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runAdminCli } from '../../src/server/admin-cli';
import { joinByInvite, makeTestbed, newRoom, waitFor, clientOptions, openSocket, type Testbed } from '../helpers/testbed';
import { RoomClient } from '../../src/lib/client/roomclient';
import { parseInviteInput } from '../../src/lib/crypto/invite';
import { ERR } from '../../src/lib/constants';
import { randomBytes } from '../../src/lib/encoding';

/**
 * The two operator commands, judged the way an operator would judge them: the exit code, what
 * they prove about the data afterwards, and what they refuse to do. Nothing here reaches the
 * product through a browser — the control socket is loopback-only and lives beside the data
 * directory, and the public listener has no admin route to call.
 */

let tb: Testbed | null = null;
afterEach(async () => {
  if (tb) await tb.cleanup();
  tb = null;
});

/** Capture what the command printed: both its report and anything the process logged. */
async function runCli(args: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const writes: ('stdout' | 'stderr')[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const capture = (which: 'stdout' | 'stderr') =>
    ((chunk: unknown, cb?: unknown): boolean => {
      chunks.push(String(chunk));
      writes.push(which);
      if (typeof cb === 'function') (cb as () => void)();
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = capture('stdout');
  process.stderr.write = capture('stderr');
  let code = -1;
  try {
    code = await runAdminCli(args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  void writes;
  return { code, out: chunks.join('') };
}

function controlFile(dataDir: string): string {
  return path.join(dataDir, 'admin-control.json');
}

describe('local admin commands', () => {
  it('1. exposes no admin route on the public listener', async () => {
    tb = await makeTestbed();
    for (const route of ['/rooms/disconnect-all', '/data/purge-all', '/__admin/rooms/disconnect-all', '/admin']) {
      const res = await fetch(`${tb.base}${route}`, { method: 'POST', body: '{}' });
      expect(res.status, route).toBe(404);
      const text = await res.text();
      expect(text, route).not.toContain('"ok"');
    }
    // The control socket is a separate, loopback-only listener recorded in the data directory.
    const file = JSON.parse(fs.readFileSync(controlFile(tb.dataDir), 'utf8')) as { port: number; token: string };
    expect(file.port).not.toBe(tb.srv.port);
    expect(file.token).toHaveLength(43);
  });

  it('2. refuses the control socket without the local token', async () => {
    tb = await makeTestbed();
    const file = JSON.parse(fs.readFileSync(controlFile(tb.dataDir), 'utf8')) as { port: number; token: string };
    const noToken = await fetch(`http://127.0.0.1:${file.port}/status`);
    expect(noToken.status).toBe(401);
    const wrongToken = await fetch(`http://127.0.0.1:${file.port}/rooms/disconnect-all`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'not-the-token-aaaaaaaaaaaaaaaaaaaaaaaaaaa'}` }
    });
    expect(wrongToken.status).toBe(401);
    const good = await fetch(`http://127.0.0.1:${file.port}/status`, {
      headers: { authorization: `Bearer ${file.token}` }
    });
    expect(good.status).toBe(200);
  });

  it('3. status reports aggregates and names no room', async () => {
    tb = await makeTestbed();
    const host = await newRoom(tb, '房主');
    const guest = await joinByInvite(tb, { code: host.publicInvite.code }, '访客');
    try {
      const run = await runCli(['status', '--data-dir', tb.dataDir]);
      expect(run.code).toBe(0);
      expect(run.out).toContain('roomsActive=1');
      expect(run.out).toContain('online=2');
      expect(run.out).not.toContain(host.publicInvite.roomId);
      // The invite code is roomId + secret in one string: it must never appear in operator output.
      expect(run.out).not.toContain(host.publicInvite.code);
    } finally {
      guest.close();
      host.close();
    }
  });

  it('4. disconnect-all empties every room, drops every socket, and takes new rooms again', async () => {
    tb = await makeTestbed();
    const a = await newRoom(tb, '甲');
    const b = await newRoom(tb, '乙');
    const aGuest = await joinByInvite(tb, { code: a.publicInvite.code }, '甲的访客');
    try {
      expect(tb.srv.service.slotsHeld()).toBe(2);
      const run = await runCli(['rooms:disconnect-all', '--yes', '--data-dir', tb.dataDir]);
      expect(run.code).toBe(0);
      expect(run.out).toContain('rooms=2');
      expect(run.out).toContain('unfinished=0');
      expect(tb.srv.service.slotsHeld()).toBe(0);
      expect((tb.srv.db.raw.prepare('SELECT COUNT(*) c FROM rooms').get() as { c: number }).c).toBe(0);
      await waitFor(() => tb!.srv.hub.totalConnections() === 0, { label: 'every socket closed' });

      // A disconnected client cannot walk back in through the old link, and stops trying.
      expect(a.status).toBe('destroyed');
      const oldLink = await joinByInvite(tb, { code: a.publicInvite.code }, '回来的甲').then(
        () => 'joined',
        (err: Error) => err.message
      );
      expect(oldLink).toBe(ERR.roomNotFound);

      // And the node accepts new rooms again.
      const c = await newRoom(tb, '新房间');
      expect(tb.srv.service.slotsHeld()).toBe(1);
      expect(run.out).not.toContain(a.publicInvite.roomId);
      c.close();
      aGuest.close();
    } finally {
      a.close();
      b.close();
    }
  });

  /**
   * The other half of "disconnected clients cannot restore via old links": a client that dials a
   * dead link must give up instead of hammering it. This counts the dials themselves by wrapping
   * the socket factory, so the judgement is on the call edge (client keeps retrying) rather than
   * on a status field that a `room:destroyed` frame could have set for other reasons.
   */
  it('4b. a client dialling a gone room dials once and stops', async () => {
    tb = await makeTestbed();
    const host = await newRoom(tb, '房主');
    const code = host.publicInvite.code;
    await host.destroy();
    host.close();
    await waitFor(() => tb!.srv.hub.totalConnections() === 0, { label: 'socket released' });

    let dials = 0;
    const opts = clientOptions(tb, {
      openSocket: (url: string) => {
        dials++;
        return openSocket(url);
      }
    });
    const parsed = parseInviteInput(code);
    if (!parsed) throw new Error('invite could not be parsed');
    const stale = RoomClient.fromSecret(opts, parsed, '反复敲旧门的人');
    await expect(stale.connect()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 3_000));
    expect(dials).toBe(1);
    expect(stale.status).toBe('destroyed');
  });

  it('5. purge-all refuses to run without an explicit confirmation', async () => {
    tb = await makeTestbed();
    const host = await newRoom(tb, '房主');
    try {
      const run = await runCli(['data:purge-all', '--data-dir', tb.dataDir]);
      // Vitest gives the command no TTY, so the only way to confirm is --yes: refusing is the
      // point, and the refusal must not be mistaken for "cleaned".
      expect(run.code).toBe(2);
      expect(run.out).toMatch(/refused|cancelled/);
      expect(tb.srv.service.slotsHeld()).toBe(1);
      expect(tb.srv.service.isPaused()).toBe(false);
    } finally {
      host.close();
    }
  });

  it('6. purge-all wipes rooms, ciphertext, sessions and attachment dirs, then serves again', async () => {
    tb = await makeTestbed();
    const a = await newRoom(tb, '甲');
    const b = await newRoom(tb, '乙');
    await a.sendText('清理之前的一句话');
    try {
      const run = await runCli(['data:purge-all', '--yes', '--data-dir', tb.dataDir]);
      expect(run.code).toBe(0);
      expect(run.out).toContain('ok=true');
      for (const t of ['rooms', 'messages', 'attachments', 'attachment_chunks', 'slots', 'session_tokens']) {
        expect((tb.srv.db.raw.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c, t).toBe(0);
      }
      expect(fs.readdirSync(tb.roomsDir)).toEqual([]);
      expect(tb.srv.service.isPaused()).toBe(false);
      expect(tb.srv.service.slotsHeld()).toBe(0);
      // Old links are dead and the WAL was truncated rather than left holding the old pages.
      const stale = await joinByInvite(tb, { code: a.publicInvite.code }, '旧的甲').then(
        () => 'joined',
        (err: Error) => err.message
      );
      expect(stale).toBe(ERR.roomNotFound);
      const wal = `${tb.dbFile}-wal`;
      if (fs.existsSync(wal)) expect(fs.statSync(wal).size).toBe(0);
      const fresh = await newRoom(tb, '清理后');
      expect(fresh.status).toBe('open');
      fresh.close();
    } finally {
      a.close();
      b.close();
    }
  });

  it('7. a cleanup that fails keeps the node in maintenance, and the same command finishes it', async () => {
    tb = await makeTestbed();
    const host = await newRoom(tb, '房主');
    const storage = tb.srv.storage as unknown as { removeRoom: (id: string) => Promise<{ files: number; bytes: number }> };
    const realRemove = storage.removeRoom.bind(tb.srv.storage);
    try {
      storage.removeRoom = async () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      };
      const failed = await runCli(['rooms:disconnect-all', '--yes', '--data-dir', tb.dataDir]);
      expect(failed.code).toBe(1);
      expect(failed.out).toMatch(/did not complete|maintenance/);
      expect(tb.srv.service.isPaused()).toBe(true);
      // It does not claim the data is gone: the room is still held in DESTROYING.
      expect(tb.srv.service.pendingDestroys().length).toBe(1);
      const refusedCreate = await fetch(`${tb.base}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'ae'.repeat(13), joinKey: Buffer.from(randomBytes(32)).toString('base64url') })
      });
      expect(refusedCreate.status).toBe(503);

      // The operator unblocks the disk; re-running the same command finishes and resumes.
      storage.removeRoom = realRemove;
      const again = await runCli(['rooms:disconnect-all', '--yes', '--data-dir', tb.dataDir]);
      expect(again.code).toBe(0);
      expect(tb.srv.service.isPaused()).toBe(false);
      expect(tb.srv.service.pendingDestroys()).toEqual([]);
    } finally {
      storage.removeRoom = realRemove;
      host.close();
    }
  });

  it('8. refuses an offline purge while the service is still running', async () => {
    tb = await makeTestbed();
    const host = await newRoom(tb, '房主');
    try {
      // The database file is open by the running node (and PM2 keeps it open in production), so
      // deleting it from under the service is the one thing this command must never do.
      const run = await runCli(['data:purge-all', '--yes', '--offline', '--data-dir', tb.dataDir]);
      expect(run.code).toBe(1);
      expect(run.out).toMatch(/is running|stop it first/);
      expect(tb.srv.service.slotsHeld()).toBe(1);
      expect(fs.existsSync(tb.dbFile)).toBe(true);
      expect(host.status).toBe('open');
    } finally {
      host.close();
    }
  });

  it('9. offline purge of a stopped node empties the database and the attachment tree', async () => {
    tb = await makeTestbed();
    const host = await newRoom(tb, '房主');
    await host.sendText('停机清理前的话');
    const dataDir = tb.dataDir;
    const dbFile = tb.dbFile;
    const roomsDir = tb.roomsDir;
    await tb.srv.close();
    tb = null;
    try {
      expect(fs.existsSync(dbFile)).toBe(true);
      const run = await runCli(['data:purge-all', '--yes', '--offline', '--data-dir', dataDir]);
      expect(run.code).toBe(0);
      expect(run.out).toContain('residualRows=0');
      expect(run.out).toContain('residualFiles=0');
      expect(fs.readdirSync(roomsDir)).toEqual([]);
      // The recreated database boots clean: no room, no session, and its WAL/SHM were replaced.
      const { Db } = await import('../../src/server/db');
      const reopened = new Db(dbFile);
      try {
        for (const t of ['rooms', 'messages', 'attachments', 'attachment_chunks', 'slots', 'session_tokens']) {
          expect((reopened.raw.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c, t).toBe(0);
        }
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
