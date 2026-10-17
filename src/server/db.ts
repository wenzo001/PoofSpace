import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { RoomStatus } from '../lib/constants';

export const SCHEMA_VERSION = 3;

export interface RoomRow {
  id: string;
  status: RoomStatus;
  join_key: Uint8Array;
  creator_token: Uint8Array;
  max_members: number;
  next_slot: number;
  head_seq: number;
  created_at: number;
  updated_at: number;
  empty_since: number | null;
  destroy_reason: string | null;
  destroyed_at: number | null;
  attachment_bytes: number;
  idle_delay_ms: number | null;
}

export interface SlotRow {
  room_id: string;
  slot: number;
  gen: number;
  is_creator: number;
  nick: Uint8Array | null;
  nick_nonce: Uint8Array | null;
  joined_at: number;
  last_seen: number;
  connected: number;
}

export interface MessageRow {
  room_id: string;
  seq: number;
  client_msg_id: string;
  sender_slot: number;
  nonce: Uint8Array;
  ct: Uint8Array;
  kind: string;
  attachment_id: string | null;
  created_at: number;
}

export interface AttachmentRow {
  id: string;
  room_id: string;
  kind: string;
  chunk_size: number;
  chunk_count: number;
  total_bytes: number;
  meta: Uint8Array;
  meta_nonce: Uint8Array;
  uploaded_chunks: number;
  uploaded_bytes: number;
  complete: number;
  state: string;
  created_at: number;
  expires_at: number;
  creator_slot: number;
}

const ROOMS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','IDLE_GRACE','DESTROYING','DESTROYED')),
  join_key BLOB NOT NULL,
  creator_token BLOB NOT NULL,
  max_members INTEGER NOT NULL,
  next_slot INTEGER NOT NULL DEFAULT 1,
  head_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  empty_since INTEGER,
  destroy_reason TEXT,
  destroyed_at INTEGER,
  attachment_bytes INTEGER NOT NULL DEFAULT 0,
  -- Per-room override of the recovery window, armed by the creator and consumed once. NULL means
  -- "use the node default". The expiry instant is never stored: it stays derived from empty_since,
  -- so a restart cannot disagree with a sweep about when a room dies.
  idle_delay_ms INTEGER
)`;

/**
 * The shape v2 was, kept verbatim because `migrateV1toV2` rebuilds into it. If that hop built the
 * *current* table instead, a v1 file would arrive at v3 having skipped the v2->v3 hop entirely, and
 * the test that exists to prove the chain does not skip would pass with the hop deleted.
 */
const ROOMS_V2_DDL = `CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','IDLE_GRACE','DESTROYING','DESTROYED')),
  join_key BLOB NOT NULL,
  creator_token BLOB NOT NULL,
  max_members INTEGER NOT NULL,
  next_slot INTEGER NOT NULL DEFAULT 1,
  head_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  empty_since INTEGER,
  destroy_reason TEXT,
  destroyed_at INTEGER,
  attachment_bytes INTEGER NOT NULL DEFAULT 0
)`;

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
-- This database only ever holds ciphertext and run metadata for rooms that are alive or still
-- inside their recovery window, so freed pages are zeroed on the way out instead of being left
-- in the free list where a later read of the file could pick them back up.
PRAGMA secure_delete = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

${ROOMS_TABLE_DDL};
CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms(status);

CREATE TABLE IF NOT EXISTS slots (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  gen INTEGER NOT NULL,
  is_creator INTEGER NOT NULL DEFAULT 0,
  nick BLOB,
  nick_nonce BLOB,
  joined_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  connected INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, slot)
);

CREATE TABLE IF NOT EXISTS messages (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  client_msg_id TEXT NOT NULL,
  sender_slot INTEGER NOT NULL,
  nonce BLOB NOT NULL,
  ct BLOB NOT NULL,
  kind TEXT NOT NULL,
  attachment_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, seq),
  UNIQUE (room_id, client_msg_id)
);
CREATE INDEX IF NOT EXISTS messages_room_seq_idx ON messages(room_id, seq DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  meta BLOB NOT NULL,
  meta_nonce BLOB NOT NULL,
  uploaded_chunks INTEGER NOT NULL DEFAULT 0,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'PENDING',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  creator_slot INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_room_idx ON attachments(room_id);
CREATE INDEX IF NOT EXISTS attachments_expiry_idx ON attachments(state, expires_at);

CREATE TABLE IF NOT EXISTS attachment_chunks (
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, idx)
);

CREATE TABLE IF NOT EXISTS session_tokens (
  token TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL,
  gen INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_tokens_room_idx ON session_tokens(room_id);
`;

export class Db {
  readonly raw: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this.raw = new Database(file);
    try {
      this.raw.exec(DDL);
      const row = this.raw.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
      const v = row ? Number(row.value) : SCHEMA_VERSION;
      if (!row) {
        this.raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
      } else if (v === 1) {
        // Both hops, in order. A branch per version that each stamps SCHEMA_VERSION itself would
        // mark a v1 file as v3 without ever running v2->v3, and the column would be missing on the
        // one deployment that has been upgraded twice.
        migrateV1toV2(this.raw);
        migrateV2toV3(this.raw);
        this.raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
      } else if (v === 2) {
        migrateV2toV3(this.raw);
        this.raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
      } else if (v !== SCHEMA_VERSION) {
        throw new Error(`Unsupported database schema version ${row.value}; expected ${SCHEMA_VERSION}`);
      }
    } catch (err) {
      // A refused boot must not leave the file open: on Windows that locks the whole data
      // directory, and the operator then sees a permission error instead of the real reason.
      try {
        this.raw.close();
      } catch {
        /* the handle was already gone */
      }
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }

  /** Checkpoint + truncate WAL so destroyed data cannot linger in -wal/-shm files. */
  checkpoint(): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)');
  }

  freelistPages(): number {
    return Number(this.raw.pragma('freelist_count', { simple: true }));
  }

  /**
   * DELETE only unlinks pages: secure_delete zeroes them, but the file keeps its high-water
   * mark. VACUUM rewrites it, so a room that was destroyed long ago cannot be recovered by
   * reading the tail of the database file. Runs rarely, once enough pages are loose.
   */
  vacuumIfFragmented(thresholdPages: number): boolean {
    if (thresholdPages <= 0 || this.freelistPages() < thresholdPages) return false;
    this.raw.exec('VACUUM');
    this.checkpoint();
    return true;
  }

  vacuum(): void {
    this.raw.exec('VACUUM');
    this.checkpoint();
  }

  tx<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }
}

/**
 * v1 had no IDLE_GRACE state, so its CHECK rejected it. The rooms table is rebuilt in place
 * rather than wiped: a redeploy must not clear rooms that are still inside their recovery
 * window, and an empty_since set under v1 already means "everyone left" under v2.
 */
function migrateV1toV2(raw: Database.Database): void {
  // PRAGMA foreign_keys is ignored inside a transaction, so it has to be flipped around it.
  raw.pragma('foreign_keys = OFF');
  raw.transaction(() => {
    raw.exec(
      ROOMS_V2_DDL.replace('CREATE TABLE IF NOT EXISTS rooms', 'CREATE TABLE rooms_v2') +
        `;
        INSERT INTO rooms_v2 (id,status,join_key,creator_token,max_members,next_slot,head_seq,created_at,updated_at,empty_since,destroy_reason,destroyed_at,attachment_bytes)
        SELECT id,
               CASE WHEN status='ACTIVE' AND empty_since IS NOT NULL THEN 'IDLE_GRACE' ELSE status END,
               join_key,creator_token,max_members,next_slot,head_seq,created_at,updated_at,empty_since,destroy_reason,destroyed_at,attachment_bytes
        FROM rooms;
        DROP TABLE rooms;
        ALTER TABLE rooms_v2 RENAME TO rooms;
        CREATE INDEX IF NOT EXISTS rooms_status_idx ON rooms(status);`
    );
  })();
  raw.pragma('foreign_keys = ON');
  const broken = raw.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) throw new Error(`schema migration left ${broken.length} orphan rows`);
}

/**
 * v3 adds one nullable column. A nullable ADD COLUMN is in-place in SQLite, so unlike v1->v2 there
 * is no table rebuild -- and every room that is inside its window right now has to survive this,
 * because the deployment carrying this code is already running with data in it.
 */
function migrateV2toV3(raw: Database.Database): void {
  const cols = (raw.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('idle_delay_ms')) raw.exec('ALTER TABLE rooms ADD COLUMN idle_delay_ms INTEGER');
  const broken = raw.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) throw new Error(`schema migration left ${broken.length} orphan rows`);
}
