# Changelog

All notable changes to PoofSpace are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[semantic versioning](https://semver.org/).

Verification for every entry below means: `npm run gates` strict table with `PASS / FAIL / SKIP`
where a skip is never a pass, plus mutation evidence for each new judgement (the product was
deliberately broken and the gate had to go red). Readings live in `docs/TEST-REPORT.md`, unmet
claims in `docs/DEBT.md`.

## 1.0.1 — 2026-10-16

Everything here came out of using the app in a browser, not out of the specification.

### Fixed

- A queued upload no longer stalls the rest of the queue. The serial upload lock was released in a
  `finally()` that runs after React has already flushed the state update, so the effect re-ran while
  the lock was still held and every file after the first waited forever at "0/N chunks". Selecting or
  pasting several files now sends all of them. The queue pill also says `排队中` for a job that has
  not started, instead of calling it `上传中`.
- Scrolling up through a room's history no longer drags the canvas back down. Three separate causes:
  the list and the browser were both holding the scroll position (`.list` now sets
  `overflow-anchor: none`, so exactly one owner decides), the hold was taken from a `scrollTop` that
  lagged the reader's own gesture by a frame, and the correction cancelled a wheel turn that had
  already landed instead of only compensating content that moved underneath. Measured on a late
  joiner in a 101-message room: steady steps `0px` (was −12…−16px per step), the step where a whole
  page of older history lands `260px` (was `4118px`). The remaining step's worth is registered as
  `docs/DEBT.md` D28, not claimed as fixed.
- A file card is a card again. Its icon had no size rule anywhere in the stylesheet, and an SVG with a
  viewBox inside a flex row takes the full containing-block width — measured 403×403 — so the name
  collapsed to zero width, the size text stacked one glyph per line and the download button was pushed
  outside the card. Now `icon 32x32; text column 327px; overflow 0px; button inside=true`.
- 展开全文 no longer expands the bubble underneath the dialog. Growing that row re-windowed the list,
  unmounted the row, and the dialog was rendered by that row — so opening it destroyed it. The bubble
  keeps its excerpt; the dialog does the reading, and it now scrolls inside its own box with both
  buttons reachable (`modal 559px in a 720px viewport; scrolled to end=true`).
- The deployment package no longer points at documentation it does not carry. `README.md`,
  `README.zh-CN.md`, `CHANGELOG.md` and `docs/TEST-REPORT.md` all name `docs/DEBT.md`, and the README
  names `docs/ARCHITECTURE.md`, while neither was in the shipped set — a reader following the pointer
  landed on nothing. Both now travel with the artifact, and the artifact audit refuses any shipped
  markdown that names a `docs/*.md` file present in the source tree but missing from the package
  (witness: dropping `docs/DEBT.md` from the list fails the audit on four pointers).

- `npm run dev` was inert: the custom server destroyed every WebSocket upgrade that was not `/ws`,
  which killed Next's dev hot-reload socket, so the page rendered but React never hydrated and every
  button on screen did nothing. Only the dev runtime now receives non-`/ws` upgrades; production
  still accepts exactly one upgrade path.
- Attachment metadata is fetched by id when a peer's message frame carries only the id. Before this an
  uploaded image or file stayed a permanent loading box for everyone except the uploader — and the box
  was rendered twice.
- The pinned chat list no longer steps back upward when a message arrives: the resize observer wrote a
  map built from a stale closure, dropping other rows' measured heights and re-pinning to a shorter
  container.
- The development Content-Security-Policy allows `'unsafe-eval'` (React's development build needs it);
  the shipped policy is unchanged, and a new check fails if the exemption ever leaks into production.

### Changed

- A device with no cached nickname is no longer named silently. The first create or join offers a
  generated name, lets the reader swap it, and caches only what they confirmed; after that the name
  changes only when they change it.
- Destroying a room (or having it destroyed) leaves the room view and returns to the home page; the
  dead room's credential is dropped first, so the history list cannot offer to re-enter it.
- Own messages no longer carry an avatar or an author label — only peers are named — and the message
  rows, bubbles and avatar are tighter.
- The per-message copy control appears on hover on pointers that have one, stays visible on touch,
  reaches a 44px band without growing the visible pill, and copies the selected text when the reader
  has selected some.
- The home page's list of this device's still-live rooms is labelled as history.
- Labels sit on their control's centre line now. Buttons and pills that had a `min-height` and
  padding but no centring box pushed their text toward the top — measured with a `Range` over each
  control's contents, the worst offset across seven controls went from 12px (the home page's
  恢复进入 link, a 44px-tall anchor whose text sat at the top) to **0.5px**.
- The per-message copy control is no longer a bordered button. It is a grey text pill
  (`--mute`, 11px, no border) that only gets a background on hover; measured contrast against its
  own bubble is 5.06:1, so weakening it did not take it below AA for small text.
- Chat is tighter and reads as one system: rows `2px` apart, bubbles `5px 10px` on a 16px radius with
  `line-height: 1.4`, a 26px peer avatar, tabular numerals on timestamps, a translucent
  `saturate + blur` header and composer over a single hairline, `scale(0.97)` press feedback on every
  tappable control, and overlay scrollbars. Own rows carry no avatar or author label.
- The keyboard focus ring is 1.5px with a 1px offset instead of 2px with 2px: still the same
  full-contrast teal, because it is the only indicator a keyboard reader gets, but it no longer
  out-shouts the message list.
- 展开全文 excerpts at 180 characters or 6 lines (was 280/10) so a long message costs the list one
  short row instead of a screen, and the dialog's text scrolls in its own box.
- The upload queue names its states honestly: `排队中` for a job that has not started, `上传中` for
  one that is transferring, `失败` with a retry control.

### Testing

- The real-browser lane grew from 10 legs to 16, then to 21 in the same release: clipboard paste
  carrying every item, a file card judged on its rendered geometry, label centring measured with a
  `Range` over each control's contents, the full-text dialog judged on scrolling inside its own box,
  and a late joiner scrolling up through a page of history they never saw live.
- Two instrument lessons came out of this round and both changed how a leg is written. A leg that
  reads the geometry only *after* the page settles measures whether a still page stays still — which
  it always does, fixed or broken — so the scroll leg now takes its baseline in the same task as the
  gesture. And with the browser's own scroll anchoring left enabled, that leg read `0px` whether the
  product held the row or not; a judgement that cannot be made red is not a judgement, so `.list`
  sets `overflow-anchor: none` and the leg reads `4118px` on the broken build.
- Red legs now dump the page they are waiting on (`chatState`) instead of timing out, which is how the
  multi-file stall was named (`queue="排队中 剪贴板里的文件.txt 0/1块"`) rather than guessed at.
- The lane boots with `MAX_ROOMS=80`: its own legs create more rooms than the shipped default of 20,
  and a capacity ceiling reached by the harness is not a product refusal.

- The real-browser lane grew from 10 legs to 16: first-run naming, an uploaded image reaching the
  other device, joined rooms appearing as history, both devices landing on the home page after a
  destroy, the copy control judged on what the clipboard actually received, and the parked list
  judged frame by frame.
- `npm test` runs the suite in two invocations so the 100-member lane gets its own process, and the
  test bed retries a WebSocket *connect* that the operating system refused — never a `ROOM_FULL` or
  any product refusal (proved by re-refusing every join and watching the lane go red).
- Acceptance for this release: 16 gates `PASS / 0 FAIL / 0 SKIP`, 157 automated checks, 21 browser
  legs. Mutation evidence per judgement — seven knives this round, each proven red at the layer the
  harness actually boots — plus three earlier knives that came back as equivalent mutations and are
  recorded as gaps rather than as passes, in `docs/TEST-REPORT.md` §7.7 and §7.9 and `docs/DEBT.md`
  D21–D29.

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
  real-browser lane in chromium over both a non-secure HTTP origin and genuine TLS, where each claim
  about what a reader sees is judged on rendered geometry (row heights, scroll offsets, clipboard
  contents, computed visibility) rather than on the presence of a DOM node.

### Known limitations

Registered as falsifiable ledger entries rather than as reassurance — see `docs/DEBT.md`:
no forward secrecy, no member revocation, no claim of absolute (medium-level) erasure,
`script-src 'unsafe-inline'` retained for Next.js App Router flight scripts, and several
guarantees verified with two browser contexts on one machine rather than two physical devices.
