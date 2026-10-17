# PoofSpace

**Create a room, share the link, chat end-to-end encrypted. When the last person leaves, the room burns itself down — and leaves nothing on the server that could be read later.**

PoofSpace is a self-hosted, registration-free, multi-party E2EE chat room in a single Node.js process.
No accounts, no friends list, no directory, no analytics, no external database, no object storage.
One process, one SQLite file used as *ephemeral* runtime state, one temporary attachment directory.

中文文档见 [README.zh-CN.md](README.zh-CN.md)（仓库内其余 `docs/*` 目前为中文）。

---

## Who this is for

A team or a group of machines inside one network that wants ad-hoc encrypted group chat — including
file transfer — without provisioning an identity provider, and without trusting the host with content.
If you need history that outlives the room, multi-device sync, or an audit trail, this is the wrong
project: those are exactly the things PoofSpace refuses to keep.

## What it does

| | |
| --- | --- |
| **Create → share** | 128-bit random room id + 256-bit secret generated **in the browser**. The secret travels only in the URL `#` fragment, which never reaches a server, and in the invite code you paste to whoever you invite. |
| **Enter → chat** | Text messages plus arbitrary files and images, encrypted client-side before upload. One attachment control sends several at once, and **the file's own type decides how it renders** — a picture appears as a picture, anything else as a card; the same split applies to what you paste. Paste a screenshot, a copied image or a copied file anywhere on the page and every item goes; the clipboard's *text* is left to the input box. Sending takes you back to the bottom, and an inbound message only does so when you were already there. Late joiners can decrypt and read the history that is still held, and scrolling up through it keeps the row you were reading instead of pulling you back to the bottom (the one step where a whole older page lands still moves about a wheel notch: `docs/DEBT.md` D28). Tapping a picture opens a viewer that zooms (wheel, double-tap or pinch), pans, pages through this room's images with the arrow keys or a swipe, and closes on Escape; the decrypted original lives only in a blob URL and is released the moment the viewer closes. |
| **Last one out → countdown** | `ACTIVE → IDLE_GRACE (300 s) → DESTROYING → DESTROYED`. Anyone holding the invite can walk back into **the same room** during the window; the countdown is cancelled, history intact. The home page lists this device's still-live rooms and says how many were connected the last time it was inside — a local snapshot, because asking over the network would mean joining, and joining would cancel the countdown. |
| **Auto destroy** | No manual cleanup needed. Destroy removes ciphertext, attachment chunks, partial uploads, sessions and the room row itself — a destroyed room leaves **no database record at all**. The room owner may arm a one-time longer window for the next absence (4/8/12/24/36/72 hours from the header); anyone returning inside the countdown cancels it and consumes the arming, and the node caps how many rooms may hold one at a time (`MAX_DELAYED_ROOMS`, default 5). |
| **Server can't read it** | The server stores room state, random ids, ciphertext and minimal run metadata. It never receives a key, plaintext, filename, or MIME type. |

## What it explicitly does *not* claim

Being honest here is part of the product, so these are stated in the UI and in `docs/SECURITY.md` too:

- **No forward secrecy.** Compromising a room secret reveals that room's stored history.
- **No member revocation.** Someone who leaves and keeps the link can rejoin while the room exists.
- **No absolute erasure.** Screenshots, copy-pasted text, already-downloaded files, filesystem
  journals, snapshots and SSD wear-levelling are outside what any application can delete. PoofSpace
  claims only: no usable application-level recovery path, controlled storage was cleaned, and the
  server cannot decrypt any residue.
- **HTTPS is not E2EE.** A lock icon means the *transport* is encrypted; the room content is
  encrypted separately, and works over plain HTTP too (see below).

## Quick start (development)

```bash
npm install
npm run dev          # custom Node server + Next.js, http://localhost:3000
```

Requirements: Node.js ≥ 20.9 (developed and verified on v24.16.0). `better-sqlite3` builds a native
module, so a toolchain or a matching prebuilt binary is needed on the target platform.

```bash
npm test             # 14 files / 157 automated checks (two invocations: the suite, then the 100-member perf lane)
npm run typecheck
npm run gates        # the full acceptance table (B1–B10 + T1–T6)
npm run release      # build → stage artifact → boot it → extract the tarball and boot that too
```

## Deploying

```bash
npm run build
HOST=0.0.0.0 PORT=3000 DATA_DIR=/srv/poofspace/data pm2 start ecosystem.config.cjs --env production
node scripts/healthcheck.mjs --port 3000 --retries 10
```

PM2 runs **fork mode with exactly one instance**: WebSocket connections, room state, rate-limit
buckets and the SQLite file all live in that single process. Scale behind a load balancer on
separate machines rather than by adding instances.

Supported shapes (all from environment variables, no hardcoded domain/IP/port/protocol in source):
LAN IP + HTTP, public IP + HTTP, domain + HTTPS, IP + HTTPS, and Nginx-terminating-HTTPS → Node HTTP.
The client picks `ws://` or `wss://` from the page protocol. See `docs/DEPLOYMENT.md` for all five
with copy-paste config, the full env table, and the nginx example.

Two caveats operators hit in practice:

- `data/` must point at persistent disk and must **never** be served as static content. The release
  audit (gate B2/B5) checks that no runtime data ships in the artifact.
- Capacity variables are validated **at boot**: `MAX_ROOMS=0`, `MAX_ROOMS=many`,
  `ROOM_IDLE_TTL_SECONDS=5` stop the process and name the offending variable instead of silently
  falling back to a default.

### Configuration at a glance

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_ROOMS` | `20` | Rooms this node holds at once. `ACTIVE`, `IDLE_GRACE` and a not-yet-cleaned `DESTROYING` all occupy a slot. |
| `MAX_DELAYED_ROOMS` | `5` | How many rooms may simultaneously hold an owner-armed longer recovery window (`0..MAX_ROOMS`; `0` switches the feature off). Those rooms still count against `MAX_ROOMS`. |
| `MAX_PARTICIPANTS_PER_ROOM` | `100` | Per-room member cap, enforced server-side (a client asking for more gets this). |
| `ROOM_IDLE_TTL_SECONDS` | `300` | Recovery window after the last participant leaves. Wall-clock, so downtime counts. |
| `MAX_CONNECTIONS_NODE` / `MAX_CONNECTIONS_PER_IP` | `4000` / `512` | WebSocket ceilings, refused with HTTP 503 before the handshake. |
| `ATTACHMENT_BYTES_MAX` / `ROOM_ATTACHMENT_BYTES_MAX` / `TEMP_BYTES_MAX_NODE` | `256 MiB` / `2 GiB` / `20 GiB` | Per-file, per-room and per-node ciphertext quotas. |
| `DATA_DIR` / `DB_FILE` / `ROOMS_DIR` | `./data` | Ephemeral database file and attachment root. |
| `TLS_KEY_FILE` + `TLS_CERT_FILE` | off | Serve HTTPS directly from Node. |
| `TRUST_PROXY` | `false` | Only then are `X-Forwarded-*` headers consulted. |

The full table (heartbeats, chunk sizes, upload TTL, VACUUM threshold, admin control file) is in
`docs/DEPLOYMENT.md`.

## Operations: two commands, local only

```bash
npm run admin:status                              # aggregate counters, nothing else
npm run admin:rooms:disconnect-all -- --yes       # stop admitting, destroy every room, drop every socket
npm run admin:data:purge-all -- --yes             # wipe all rooms/ciphertext/sessions/temp storage, then resume
```

There is **no HTTP admin interface**: no `/admin` route on the public listener, no admin button in the
UI, no user-role permission system. The control channel is a second socket bound to `127.0.0.1` only,
whose port and one-time token are written to `$DATA_DIR/admin-control.json` (`0600`) — so reaching it
already requires the deploy directory and the OS account. Requests without the token get 401.

Safety properties, each with a test behind it (`tests/admin/`):

- The blast radius is printed before anything happens; `data:purge-all` additionally requires an
  explicit confirmation (`PURGE` typed interactively, or `--yes` non-interactively).
- Exit codes are machine-checkable: `0` done, `1` failed or left in maintenance, `2` usage /
  confirmation refused, `3` service not reachable.
- Output contains counts only — never room ids, invite material, tokens or content.
- A cleanup that cannot prove itself keeps the node in maintenance and says so; it never reports a
  clean slate it did not deliver. Re-running the same command finishes the work and resumes.
- While the service is running, `--offline` refuses to delete a database the server still has open.

## How the guarantees are tested

This repository does not accept "looks secure". Every gate was mutation-tested first — i.e. the code
was deliberately broken and the gate was required to go red — and skipped checks are never counted as
passing (`SKIP` is a distinct verdict, and the strict table fails on it).

Current state: **16 gates PASS / 0 FAIL / 0 SKIP** (`npm run gates`), 157 automated checks, plus a
real-browser lane (29 legs) that renders the app in chromium over both `http://<ip>:<port>` (a genuine
non-secure context, where `crypto.subtle` is absent and the bundled pure-JS AES-GCM path is used) and
real TLS. The 100-member lane has died before printing a single assertion on roughly half of the
full-table runs on the development machine (`0 files, 0 tests` + `ERR_IPC_CHANNEL_CLOSED`); a crashed
lane is never counted as a pass, and the open investigation is `docs/DEBT.md` D26. Highlights:

- Ciphertext-only at rest: the same plaintext marker is searched for in outgoing WebSocket frames, the
  SQLite file and the room temp directory — and must appear in none of them.
- Forged proofs, replayed destroys, tampered chunks, moved chunk indices, cross-room session tokens
  and keyless decryption attempts are each refused, separately.
- A destroyed room leaves no row, no file, and no recoverable page: the acceptance test byte-scans the
  whole data directory for the old ciphertext after checkpoint + VACUUM.
- Rejoin at 299 s restores the same room; at 301 s the invite is refused; a refresh that drops the
  socket does not destroy anything.
- The packaged artifact is proven to be built from this tree (`sourceNewestMs` vs `outputNewestMs`),
  and both the staged copy and the *extracted tarball* are booted and exercised end to end.

Readings, evidence and the mutation ledger: `docs/TEST-REPORT.md`.
Not-yet-verified claims are registered as a falsifiable ledger, not as reassurance: `docs/DEBT.md`.

## Design notes

- `docs/ARCHITECTURE.md` — module boundaries, data model, the lifecycle state machine, capacity
  accounting, backpressure, and why the admin channel is not on HTTP.
- `docs/SECURITY.md` — threat model, key derivation and nonce discipline, AAD binding, what logs
  contain (nothing identifying), the non-enumerability rules, and the CSP trade-off (`'unsafe-inline'`
  is there for Next's inline flight scripts, not by choice).
- `docs/DEPLOYMENT.md` — the five shapes, PM2, env table, upgrade/migration behaviour, ops commands.

Crypto is bundled: AES-256-GCM and HKDF come from Web Crypto when present, otherwise from
`@noble/ciphers` compiled into the client bundle. **Nothing is fetched from a CDN at runtime** — an
offline LAN deployment must not depend on the internet to encrypt.

## Layout

```
src/server/     single-process server: lifecycle, capacity, ws, http api, storage, admin channel
src/lib/crypto/ envelope, keys, invite encoding (shared by client and tests)
src/lib/client/ room client, store, vault (local credentials), virtual list, notifications
src/components/ HomeView, RoomView, dialogs
tests/          unit · integration · security · lifecycle · storage · capacity · admin · perf
scripts/        gate harness, release packaging, real-browser lane, healthcheck
docs/           architecture, security, deployment, test report, debt ledger (+ .docx copies)
```

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the commit/version conventions and the one
rule that shapes the test culture here: a check you have not seen fail is not a check.

Run `npm run typecheck && npm test` before opening a pull request, and `npm run gates` for anything
touching lifecycle, capacity, storage cleanup or the crypto path. If you add a check, prove it can
fail: state the exact line you broke to see it go red. Tests never assert on wall-clock budgets that
were not measured on both sides of a change, and UI assertions must land on rendered geometry/DOM
state rather than "the component exists".

## License

MIT — see [LICENSE](LICENSE). Note that `package.json` keeps `"private": true`: this project is
distributed as source, not as an npm package.

Security issues: see [SECURITY.md](SECURITY.md) for how to report privately, and for which
limitations are design properties rather than bugs.
