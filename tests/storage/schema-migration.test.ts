import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Db, SCHEMA_VERSION } from '../../src/server/db';

/**
 * The v2 rooms table, copied from git history. `Db` runs `CREATE TABLE IF NOT EXISTS`, so an
 * existing rooms table is exactly the case where a new column silently never arrives -- and the
 * database on the deployed machine is such a table.
 */
const ROOMS_V2 = `CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','IDLE_GRACE','DESTROYING','DESTROYED')),
  join_key BLOB NOT NULL, creator_token BLOB NOT NULL, max_members INTEGER NOT NULL,
  next_slot INTEGER NOT NULL DEFAULT 1, head_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, empty_since INTEGER,
  destroy_reason TEXT, destroyed_at INTEGER, attachment_bytes INTEGER NOT NULL DEFAULT 0
)`;

function columns(db: Db): string[] {
  return (db.raw.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map((c) => c.name);
}

function version(db: Db): string {
  return String((db.raw.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value);
}

function seedV2Db(): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poof-mig-'));
  const file = path.join(dir, 'poofspace.sqlite');
  const raw = new Database(file);
  raw.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  raw.exec(ROOMS_V2);
  raw.prepare("INSERT INTO meta (key,value) VALUES ('schema_version','2')").run();
  const t = Date.now();
  raw.prepare(
    `INSERT INTO rooms (id,status,join_key,creator_token,max_members,created_at,updated_at,empty_since)
     VALUES ('r1','IDLE_GRACE',x'00',x'00',100,?,?,?)`
  ).run(t, t, t - 1000);
  raw.close();
  return { file, dir };
}

/**
 * Windows keeps the `-wal`/`-shm` handles a moment after close, and an `EPERM` thrown out of a
 * `finally` replaces the assertion that actually failed. So the handle is always closed and the
 * removal retries: a teardown hiccup must never be readable as a verdict.
 */
function dispose(db: Db | null, dir: string): void {
  try {
    db?.close();
  } catch {
    /* already closed by the code under test */
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

describe('schema migration to the per-room recovery window', () => {
  it('1. boots a v2 file, adds the column, and deletes no room', () => {
    const { file, dir } = seedV2Db();
    let db: Db | null = null;
    try {
      db = new Db(file);
      expect(SCHEMA_VERSION).toBe(3);
      expect(version(db)).toBe('3');
      expect(columns(db)).toContain('idle_delay_ms');
      expect(db.raw.prepare('SELECT COUNT(*) c FROM rooms').get()).toEqual({ c: 1 });
    } finally {
      dispose(db, dir);
    }
  });

  /**
   * The only witness that the chain does not skip a hop: a v1 file has to pass through *both*
   * migrations, and the column can only arrive from the second one. Deleting that second call from
   * the v1 branch must turn this red while test 1 stays green -- otherwise this file would be
   * proving "it boots", which the v2 arm already proves.
   */
  it('2. a v1 file reaches 3 with the column, i.e. the chain does not skip a hop', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poof-mig1-'));
    const file = path.join(dir, 'poofspace.sqlite');
    const raw = new Database(file);
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','1');");
    raw.exec(ROOMS_V2.replace("CHECK (status IN ('ACTIVE','IDLE_GRACE','DESTROYING','DESTROYED'))", "CHECK (status IN ('ACTIVE','DESTROYING','DESTROYED'))"));
    raw.prepare(
      "INSERT INTO rooms (id,status,join_key,creator_token,max_members,created_at,updated_at) VALUES ('r1','ACTIVE',x'00',x'00',100,1,1)"
    ).run();
    raw.close();
    let db: Db | null = null;
    try {
      db = new Db(file);
      expect(version(db)).toBe('3');
      expect(columns(db)).toContain('idle_delay_ms');
      // The v1 row also has to have taken the v2 hop: an ACTIVE room with an empty_since would be
      // IDLE_GRACE by now, and this one has neither -- so what is being proved here is the column.
      expect(db.raw.prepare('SELECT COUNT(*) c FROM rooms').get()).toEqual({ c: 1 });
    } finally {
      dispose(db, dir);
    }
  });
});
