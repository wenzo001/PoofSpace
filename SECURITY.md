# Security policy

## Reporting a vulnerability

Open a **private** security advisory through GitHub's "Report a vulnerability" button on the
repository's Security tab. Do not open a public issue for a live vulnerability.

If private advisories are not enabled on the repository, open an issue whose title is only
`security: private disclosure requested` (no details in the body) so a maintainer can send you a
direct channel before anything is written down publicly.

What helps triage fastest: the commit SHA or `release/build-info.json` stamp, the deployment shape
(plain HTTP on a LAN IP, IP + HTTPS, domain behind nginx with `TRUST_PROXY`, …), the browser and
whether `window.isSecureContext` was true, and a reproducing command line — the gate table
(`npm run gates`) and the browser lane (`npm run test:browser`) already speak in those terms.

Expect an acknowledgement within 5 business days. You do not need to write the patch, but a test
that shows the failure is welcome and will be credited.

## What the design already assumes is hostile

Reporting these is useful when you can show the protection actually fails, because they are the
threat model's starting assumptions, not surprises:

- **The host is semi-honest.** The server is assumed to see every room id, every invite code
  transmitted to it, all ciphertext, all attachment bytes and all timing. It is designed never to
  hold the room secret; "I own the server and can read your SQLite file" is expected to yield
  ciphertext only. If you recovered plaintext from server-side state alone, that is a real bug —
  report it.
- **Anyone with the link has the room.** An invite link carries the secret in its `#` fragment and
  an invite code is a bearer credential. Leak it and you have given out the room. This is a
  property, not a defect.
- **The device is a target.** Room credentials live in that browser's `localStorage`. XSS, a
  malicious extension, or someone with the device reads the room. CSP exists to narrow this; it is
  not a guarantee (see the `'unsafe-inline'` trade-off documented in `docs/SECURITY.md`).
- **Transport is separate from content.** Plain HTTP gives you encrypted *content* and no
  transport protection: an on-path attacker can serve you different JavaScript. That is why the
  page states it, and why the acceptance table asserts the copy matches the real protocol.

## What is out of scope as a vulnerability

These are stated limitations of the design, not flaws to be reported:

- No forward secrecy: a later-compromised room secret can decrypt that room's retained history.
- No member revocation: someone who leaves and kept the link can rejoin while the room exists.
- No absolute erasure: screenshots, copy-paste, already-downloaded files, filesystem journals,
  snapshots and SSD wear-levelling are outside what an application can delete.
- Rooms self-destruct after the idle window (`ROOM_IDLE_TTL_SECONDS`, default 300 s) with no way to
  recover them — that is the product.
- DoS against your own deployment: use the documented ceilings (`MAX_ROOMS`, member cap,
  connection ceilings, quotas) and measure them on your target machine.

Physical access, OS-level compromise of the hosting machine, and malicious or outdated build
artifacts obtained from somewhere other than this repository are also out of scope.

## Supported versions

The current release line (`1.x`) is the supported one. Fix versions are tagged `vX.Y.Z`; see
`CHANGELOG.md`.
