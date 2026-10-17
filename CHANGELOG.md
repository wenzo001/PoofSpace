# Changelog

All notable changes to PoofSpace are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[semantic versioning](https://semver.org/).

Verification for every entry below means: `npm run gates` strict table with `PASS / FAIL / SKIP`
where a skip is never a pass, plus mutation evidence for each new judgement (the product was
deliberately broken and the gate had to go red). Readings live in `docs/TEST-REPORT.md`, unmet
claims in `docs/DEBT.md`.

## Unreleased

### Added

- The room owner can arm a one-time longer recovery window for the next absence: 4/8/12/24/36/72
  hours, chosen from a `延时` button in the room header that only the creator sees. Anyone returning
  during the countdown cancels it *and consumes the arming*, so this is a promise about the next
  absence rather than a permanent setting. `MAX_DELAYED_ROOMS` (default 5, validated `0..MAX_ROOMS`,
  `0` = feature off) caps how many rooms on a node hold one at a time; armed rooms keep counting
  against `MAX_ROOMS` exactly as before.
  - Storage: `rooms.idle_delay_ms` (nullable), reached by a **chained** migration `v1→v2→v3` so a
    database that has already been upgraded once does not refuse to boot. The expiry instant is
    never stored -- it stays `empty_since + effectiveIdleTtlMs(room)`, and that one function is the
    only place in the server that knows which window a room is in. Both judges (the sweep and
    startup recovery) ask it; the arming is authorized by the same `creator_token` path as destroy.
  - Judgements added: `tests/storage/schema-migration` (2), `tests/lifecycle/idle-delay` (6),
    `tests/governance/idle-delay-guard` (4), `tests/integration/idle-delay-api` (3), and the browser
    leg `the creator can arm a delayed destroy`. Each has its own knife; see `docs/TEST-REPORT.md`.
- Images now open in a real viewer: wheel / double-tap / pinch zoom, drag to pan, paging through the
  room's images with the arrow keys or a swipe, and Escape to close. PhotoSwipe 5.4.4 (MIT, zero
  transitive dependencies) sits behind one adapter — `src/components/ImagePreview.tsx` is the only
  file in the front end that touches its DOM, and the browser judgements read only the two
  `data-preview` hooks that adapter stamps, never a library class name.
- The attachment metadata carries the original pixel size, read once on the client before upload, so
  the viewer knows the frame before the pixels arrive instead of re-measuring the row when they do.
- Three browser legs: paging between two images of different sizes, panning a zoomed image, and
  releasing the decrypted image on close. The release leg probes the object URL with an `<img>`
  decode rather than `fetch`, because `connect-src` carries no `blob:`.

### Changed

- The artifact dependency check (gate B2) derives its expected list from the `dependencies` of the
  `package.json` inside the staged artifact. The hand-copied list could only ever complain about the
  names someone remembered to add, so a new runtime dependency that never reached the package passed.
- Every outward claim about the recovery window now follows the capability instead of the old flat
  number: the home page hero said the room burns "5 minutes after the last person leaves",
  `docs/ARCHITECTURE.md` described the temporary store as a 5-minute recovery period,
  `docs/DEPLOYMENT.md`'s upgrade note described only the v1 hop and said *every* room enters a
  300-second window, and a service comment called the window "5 minutes". SECURITY and both READMEs
  gained the qualifier ("无人 **且到期** 即销毁；默认 300 秒，房主可显式延长"), and DEPLOYMENT documents
  `MAX_DELAYED_ROOMS` plus the fact that `ROOM_IDLE_TTL_SECONDS`' 24-hour ceiling governs only the
  node default.
- The `room entered idle grace` log line printed the node default next to a room that could be armed
  for 72 hours; it now prints the window that room is actually held for.

### Fixed

- The home page's identity pill (avatar + nickname) was not centred inside the ring it draws on
  hover: the content sat 4px from the left inner edge and 12px from the right, because the padding
  had two owners and the later rule restated it as `3px 12px 3px 3px`. At 390px the name is hidden by
  design, which left a 28px avatar 3px off one side of a 45x44 box. One owner now, tokens only, and a
  44pt square at the narrow width. The hover border itself never shifted anything (measured:
  `hoverSizeDelta x=0`) -- the ring is what made the lopsided inset visible.
- Clicking the image itself used to close the preview: the old overlay's close button had no handler
  of its own, so the only way out was a click anywhere — including on the picture.
- `[data-preview="image"]` could end up stamped on more than one of the viewer's three reused slide
  holders, which made a completed page turn read as "nothing changed" — the stale holder stays first
  in document order. The adapter now keeps that hook on exactly one node.
- The zoom judgement compared the zoomed width against the *fitted* width. With the zoom capped at
  1x, a 1200px image still grew from 1080px to 1200px and the leg called that magnification; the
  judgement is now against the image's own pixel width.

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
- Full-screen furniture no longer belongs to a message row. The image preview and the 展开全文 dialog
  were both rendered by the row that opened them, and rows carry `transform: translateY(...)` from the
  virtual list — a transformed ancestor captures `position: fixed` and confines `z-index`, so a preview
  with the stylesheet's highest number still lost to the composer and travelled with the list. Both now
  portal into `<body>`: `portal to body=true` with the centre pixel resolving inside the preview while
  list rows are mounted behind it, and `the list moved 400px while the dialog moved 0px`.
- An open dialog no longer steals the keyboard. Its focus effect listed `onClose` — an inline arrow, so
  a new identity every render — among its dependencies, which re-ran the focus on each re-render and
  pulled it back into the dialog; with a long message's dialog open, typing in the composer and pressing
  Enter sent nothing (`bubbles: 1, modals: 1`). The handler moved into a ref and the effect now depends
  only on the portal mounting.
- One radius per corner. `.bubble` read `var(--r-bubble)` in the base rule while the compact pass
  restated `border-radius: 16px` after it, so the token was dead and the thumbnail — which does read
  it — measured `14px` against the bubble's `16px`. The token is the single source now, and a leg
  requires the two radii to be the same string.
- The dialog's text is selected by dragging, not by a single click: `user-select: all` became `text`.
  Witness on the broken build: `one click selected 510 char(s) of 510`; fixed: `0 char(s)` on click,
  11 on drag.
- An image message was the only kind mounted inside a mat: the bubble drew a 1px stroke and the
  thumbnail drew a second one 10px/5px inside it, each carrying its own 16px radius (measured: bubble
  190×124 around a 168×112 picture). The picture is the bubble now — one frame owner, the bubble
  clips to its own radius, and the loading placeholder gives up its stroke too so the row does not
  re-measure at the moment the pixels arrive.

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
- The home page's list of this device's still-live rooms is labelled as history. It now also says how
  many were connected the last time this device was inside. That number is a local snapshot on purpose:
  asking the server would mean joining, and joining cancels the room's idle-destroy countdown — so a
  polling "who is there now" would quietly make rooms immortal.
- The composer has one attachment control instead of two. Which button was pressed no longer decides
  anything: the file's own type does, so a `.jpg` picked from the paperclip renders as a picture rather
  than as a download card, and one batch containing a picture and a document produces one of each
  (`thumbnails=1 file cards=1`, one icon button in the composer).
- Sending your own message returns the list to the bottom; an inbound one still only does so when you
  were already near it, so the reading-position hold from this round is not traded away (`scrolled
  174px off the bottom, then sent: 0px from the bottom, last row on screen`).
- Images in the list are smaller and share the bubble's corner: `min(168px, 46vw) × 112`, with the
  thumbnail and its placeholder declared as one box so a row does not change height at the moment the
  pixels arrive.
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
- Six legs joined the lane in this pass (21 → 27): the preview outranking the chat behind it, an open
  dialog not travelling with the list, one picker splitting pictures from files, the thumbnail sharing
  the bubble's radius, sending landing at the bottom, and the home page reporting the head count seen
  while inside. Each was cut separately and each came back red with its own reading — including the
  dialog leg, which on the broken build reported `the dialog moved 400px` alongside the list's 400px.
- A seventh leg came from looking at the rendered pixels instead of at the DOM. It measures at 1280px
  *and* at 390px, because `@media (max-width: 390px)` restates `.bubble` padding further down the
  stylesheet and a same-specificity rule there would silently win on a phone. Red on the unfixed
  build: `bubble−thumbnail = 22x12px, padding 5px/10px/5px/10px, strokes 2` at both widths; green
  after: `2x2px, padding 0px, strokes 1, clipped true`. Moving the frame also made the previous
  round's corner term read the wrong node — it went red on the fixed build (`thumbnail ... radius
  0px vs bubble 16px`) before it was re-pointed, and that red is what proved the term had been
  encoding a relationship between two owners rather than a fact about one.
- An eighth leg joined while auditing the release rather than while building it: the second half of
  "scroll to the bottom when there is new content" — a message arriving *from someone else* while the
  reader is already at the bottom — had no judgement at all. The behaviour was implemented and the
  neighbouring leg looked adjacent, but that leg judges relative movement (the bottom may step
  forward by the arriving row, never backwards), so a pin that does nothing leaves its arithmetic
  intact. Green: `0px from the bottom before, 0px after four inbound messages`; red under the knife
  (the pin's assignment turned into a no-op): `46px before, 366px after, the last one on screen=false`.
  The intended second witness — that the jitter leg stays green under the same cut — did not hold:
  it failed too, by a setup timeout that is D27's usual signature, so no independence is claimed.
- One instrument bug found and fixed while doing that: the nickname leg counted the peer's naming gate
  the moment the page arrived, and the gate appears one commit after hydration. Waiting for it instead
  of sleeping turned `peer gate=0` into a stable green — the reading that looked like a product defect
  was the harness losing a race, and it is recorded as such rather than as a fix.
- `npm run dev` now says what is blocking it. It used to restart a child that refused to boot once per
  second forever, turning Next's one-line "another dev server is already running" into an unreadable
  loop; it now reads `.next/dev/lock` before starting (clearing a lock whose PID is gone, naming the
  process when one is alive) and stops after two exits within eight seconds of spawning.
- The 10→16 step of that growth covered first-run naming, an uploaded image reaching the
  other device, joined rooms appearing as history, both devices landing on the home page after a
  destroy, the copy control judged on what the clipboard actually received, and the parked list
  judged frame by frame.
- `npm test` runs the suite in two invocations so the 100-member lane gets its own process, and the
  test bed retries a WebSocket *connect* that the operating system refused — never a `ROOM_FULL` or
  any product refusal (proved by re-refusing every join and watching the lane go red).
- Acceptance for this release: 16 gates `PASS / 0 FAIL / 0 SKIP`, 157 automated checks, 29 browser
  legs. Mutation evidence per judgement — fourteen knives across the release (seven in the fourth
  round, five in the fifth, two here), each proven red at the layer the harness actually boots, and
  one judgement whose red came from the unfixed build itself rather than from a cut — plus three
  earlier knives that came back as equivalent mutations and are recorded as gaps rather than as
  passes, in `docs/TEST-REPORT.md` §7.7, §7.9, §7.11 and §7.12 and `docs/DEBT.md` D21–D31.

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
