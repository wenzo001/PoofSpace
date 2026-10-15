# Contributing

Thanks for reading this before sending a patch — this project has one unusual requirement, stated
below, and it explains most of the other conventions.

## The one rule that shapes everything

**A check you have not seen fail is not a check.** Before relying on a gate, break the thing it is
supposed to catch and show the red reading. This repository's history of real bugs is mostly a
history of *judgements that could not fail*: an assertion reading a status field that two different
code paths were allowed to set, a `min-height` that expressed no fixed tier, a timeout that was
satisfied by the thing it was measuring. When you add or change a judgement, put the mutation
reading in the pull request description: which line you broke, and what the check printed.

Related, and equally earned:

- `SKIP` is never a pass. The acceptance table has three verdicts and fails strictly on skips.
- A gate added in the same batch as the change it certifies cannot certify that batch. The batch's
  witness is a before/after reading of something that already existed.
- Judge the layer where the claim actually lands: rendered geometry and DOM state for UI, served
  bytes for a statement the server writes, counts and call-edges for "did this code path run".
- Don't write a wall-clock budget that was never measured on both sides of a change; timing windows
  miss 2× regressions, shapes don't.

## Running things

```bash
npm install
npm run typecheck          # both TypeScript projects
npm test                   # full vitest suite (~90 s on a quiet machine)
npm run build              # client tsc + server tsc + next build
npm run test:browser       # real chromium lane (needs a local chromium build)
npm run gates              # the authoritative 16-gate table; needs PM2, chromium, openssl
npm run release            # build, stage the artifact, boot it, extract the tarball, boot that
```

`npm run gates` is what a reviewer will ask about for anything touching lifecycle, capacity, storage
cleanup, the crypto path, deployment packaging or the admin commands. It cannot run in GitHub Actions
CI (that workflow is the cheap floor: typecheck, both builds, `npm run release -- --dry-run`, and the
full vitest suite), so run it locally and paste the summary line plus the evidence strings for the
gates you touched.

If you only have a filtered run, say so: `--only` reports just the named legs and the lane harnesses
record a `SKIP` for the rest, so a filtered green is not a table verdict.

## Commits, versions, releases

- Conventional-ish subject lines (`feat:`, `test:`, `fix:`, `chore:`, `docs:`), imperative, and a
  body that says *why* — the diff already says what.
- One commit per defect or per capability; don't mix unrelated changes into a fix commit. Stage
  explicit paths (`git add src/server/service.ts`), never `git add -A`, so runtime data and scratch
  logs cannot slide in.
- `data/`, `release/`, `dist/`, `.next/`, `scratch/` and `*.log` are ignored for a reason: this app's
  runtime state is *supposed* to be ephemeral, and an accidentally committed database file would be
  a long-term room record in a product that promises it keeps none.
- Version numbers are in `package.json`; a release means: update `CHANGELOG.md` (Keep a Changelog,
  semver), `npm run release`, `npm run gates` clean, then an **annotated** tag `vX.Y.Z` on the commit
  that produced the artifact. `release/build-info.json` stamps which source tree the package was built
  from, and gate B2 refuses a package older than the tree — don't tag a commit whose artifact you did
  not run the table against.

## What the code is responsible for

Two boundaries are worth knowing before you touch anything:

- **The server never learns anything that could decrypt a room.** Secrets, plaintext, filenames and
  MIME types are the client's business. If a change makes the server log, store, or need one of them,
  it is wrong regardless of how convenient it looks.
- **Capacity and lifecycle are server-side decisions.** Room counting, the recovery window, member
  caps and cleanup accounting live in the rooms table and its transactions, so they can't be talked
  around by a client. The numbers are validated at boot rather than falling back silently.

Small functions, named from what they *do*; no comments that restate the code, and a comment only
where the reason would otherwise be lost (an ordering constraint, a platform quirk, an invariant that
is not visible from the call site).
