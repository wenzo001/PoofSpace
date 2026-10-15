import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Attachment ciphertext lives outside the web root, one directory per room, so a
 * destroy can prove the bytes are gone instead of only deleting database rows.
 */
export class RoomStorage {
  constructor(private readonly roomsRoot: string) {
    fs.mkdirSync(this.roomsRoot, { recursive: true });
  }

  roomDir(roomId: string): string {
    return path.join(this.roomsRoot, safeSegment(roomId));
  }

  chunkPath(roomId: string, attachmentId: string, index: number): string {
    return path.join(this.roomDir(roomId), safeSegment(attachmentId), `${index}.bin`);
  }

  async ensureRoom(roomId: string): Promise<void> {
    await fsp.mkdir(this.roomDir(roomId), { recursive: true });
  }

  async writeChunk(roomId: string, attachmentId: string, index: number, data: Uint8Array): Promise<void> {
    const target = this.chunkPath(roomId, attachmentId, index);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, target);
  }

  async readChunk(roomId: string, attachmentId: string, index: number): Promise<Buffer | null> {
    try {
      return await fsp.readFile(this.chunkPath(roomId, attachmentId, index));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async chunkExists(roomId: string, attachmentId: string, index: number): Promise<boolean> {
    try {
      await fsp.access(this.chunkPath(roomId, attachmentId, index));
      return true;
    } catch {
      return false;
    }
  }

  async attachmentBytes(roomId: string, attachmentId: string): Promise<number> {
    const dir = path.join(this.roomDir(roomId), safeSegment(attachmentId));
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return 0;
    }
    let total = 0;
    for (const e of entries) {
      try {
        total += (await fsp.stat(path.join(dir, e))).size;
      } catch {
        /* raced with a cleanup */
      }
    }
    return total;
  }

  async removeAttachment(roomId: string, attachmentId: string): Promise<void> {
    await fsp.rm(path.join(this.roomDir(roomId), safeSegment(attachmentId)), { recursive: true, force: true });
  }

  /** Returns the number of files removed, so cleanup can be proven rather than assumed. */
  async removeRoom(roomId: string): Promise<{ files: number; bytes: number }> {
    const dir = this.roomDir(roomId);
    const stat = await this.dirStat(dir);
    await fsp.rm(dir, { recursive: true, force: true });
    if (fs.existsSync(dir)) {
      // Retry once: Windows can hold a handle briefly after a stream is closed.
      await new Promise((r) => setTimeout(r, 50));
      await fsp.rm(dir, { recursive: true, force: true });
    }
    return stat;
  }

  async dirStat(dir: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          files++;
          try {
            bytes += (await fsp.stat(full)).size;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { files, bytes };
  }

  async listRoomDirs(): Promise<string[]> {
    try {
      return await fsp.readdir(this.roomsRoot);
    } catch {
      return [];
    }
  }

  /** Sweep orphan directories left behind by a crash before the DB row existed. */
  async pruneOrphanRooms(liveRoomIds: Set<string>): Promise<string[]> {
    const removed: string[] = [];
    for (const dir of await this.listRoomDirs()) {
      if (liveRoomIds.has(dir)) continue;
      await fsp.rm(path.join(this.roomsRoot, dir), { recursive: true, force: true });
      removed.push(dir);
    }
    return removed;
  }

  /**
   * Everything under the attachment root, including the `*.tmp` halves of chunk writes that a
   * crashed upload left beside the finished files. The root directory itself is kept, because
   * the server recreates it on boot but a purge must not leave its contents behind.
   */
  async purgeAll(): Promise<{ files: number; bytes: number }> {
    const before = await this.dirStat(this.roomsRoot);
    for (const entry of await fsp.readdir(this.roomsRoot).catch(() => [] as string[])) {
      await fsp.rm(path.join(this.roomsRoot, entry), { recursive: true, force: true });
    }
    // Windows can hold a handle on a just-closed stream for a moment; retry the whole root once.
    if ((await this.countAll()) > 0) {
      await new Promise((r) => setTimeout(r, 50));
      for (const entry of await fsp.readdir(this.roomsRoot).catch(() => [] as string[])) {
        await fsp.rm(path.join(this.roomsRoot, entry), { recursive: true, force: true });
      }
    }
    return { files: before.files, bytes: before.bytes };
  }

  async countAll(): Promise<number> {
    return (await this.dirStat(this.roomsRoot)).files;
  }
}

function safeSegment(s: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error('unsafe storage segment');
  return s;
}
