# Changelog

All notable changes to PoofSpace are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[semantic versioning](https://semver.org/).

Verification for every entry below means: `npm run gates` strict table with `PASS / FAIL / SKIP`
where a skip is never a pass, plus mutation evidence for each new judgement (the product was
deliberately broken and the gate had to go red). Readings live in `docs/TEST-REPORT.md`, unmet
claims in `docs/DEBT.md`.

## 1.0.0 — 2026-10-15

First release. Single Node process, no accounts, end-to-end encrypted ephemeral group rooms.

### Added

- **Rooms**: browser-minted 128-bit room id + 256-bit secret, invite link
  `<base>/room/<room-id>#<secret>` and an invite code; the secret is never sent to the server and
  the URL fragment never leaves the browser. Creator and member privileges are separated; a room
  caps at `MAX_PARTICIPANTS_PER_ROOM` (default 100).
- **Chat**: server-owned `seq` ordering, per-message id + ack + dedupe (a duplicate arrival renders
  once), sending/sent/failed states with retry, copy, drag-selectable text, long-text collapse with
  an expand dialog, paginated history (`beforeSeq`) and gap backfill on reconnect.
- **Files and images**: encrypted in the browser before upload, including filename and MIME;
  chunked upload with bounded memory (a large file is never read whole), limited concurrency,
  progress, retry and resume; transfers never block text, heartbeats or joins.
- **E2EE layer**: AES-256-GCM with per-context AAD (room context, message id, protocol version),
  HKDF-SHA256 key derivation, strict nonce discipline, authenticated chunk frames, bundled
  pure-JS fallback when `crypto.subtle` is absent (plain HTTP / IP deployments), and refusal to send
  anything when the CSPRNG, crypto init or AEAD authentication fails.
- **Lifecycle**: `ACTIVE → IDLE_GRACE → DESTROYING → DESTROYED`. The last participant leaving opens a
  fixed 300-second (`ROOM_IDLE_TTL_SECONDS`) recovery window during which ciphertext, attachments and
  state are kept and any valid invite restores **the same room**; expiry enters `DESTROYING`, after
  which no request, refresh or restart can revive the room.
- **Capacity and resource ceilings**: node-wide `MAX_ROOMS` (default 20) counted from the rooms table
  inside the same transaction as the insert, so concurrent creates cannot bypass it; refusal carries
  no counts. Plus connection ceilings (`MAX_CONNECTIONS_NODE`, `MAX_CONNECTIONS_PER_IP`), per-member
  pending-upload cap, per-room and node-wide temp quotas, upload/heartbeat TTL sweeps, destroy-task
  retry, and startup validation of every capacity variable.
- **Storage hygiene**: ephemeral SQLite only (`secure_delete`, `busy_timeout`, WAL), destroy performs
  `wal_checkpoint(TRUNCATE)` and threshold-based `VACUUM`, cleans the attachment directory including
  partial chunks and `*.tmp` files, and deletes the room row itself — a destroyed room leaves no
  record. No room directory, no creator mapping, no per-event audit rows, no backup/archive,
  no discovery or statistics endpoints, and no room id in any log line.
- **Operations**: `ecosystem.config.cjs` (PM2 fork mode, one instance), `scripts/healthcheck.mjs`,
  and two local-only admin commands — `npm run admin:rooms:disconnect-all` and
  `npm run admin:data:purge-all` — reachable only through a loopback control socket guarded by a
  token file, with blast-radius notice, explicit confirmation for the purge, count-only output,
  machine-checkable exit codes, and a maintenance state that is never reported as "clean".
- **Release engineering**: `npm run release` walks the production dependency closure, ships the
  native `better-sqlite3` binary, audits the artifact for forbidden/missing paths, writes
  `build-info.json` with source/output stamps, and boots **both** the staged tree and the extracted
  tarball through a 10-step API + WebSocket smoke before declaring the package usable.
- **Acceptance**: 16 gates (`npm run gates`) covering the ten §13 conditions of the base specification
  and the eight-section governance specification, 156 automated checks across 14 files, and a
  10-leg real-browser lane in chromium over both a non-secure HTTP origin and genuine TLS.

### Known limitations

Registered as falsifiable ledger entries rather than as reassurance — see `docs/DEBT.md`:
no forward secrecy, no member revocation, no claim of absolute (medium-level) erasure,
`script-src 'unsafe-inline'` retained for Next.js App Router flight scripts, and several
guarantees verified with two browser contexts on one machine rather than two physical devices.
