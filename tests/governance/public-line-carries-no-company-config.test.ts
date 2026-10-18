import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Two refs, not `HEAD`. Since 2026-10-18 both lines live in one working tree, so whichever branch
 * happens to be checked out says nothing about which line is being audited -- and sitting on the
 * company line while reading `HEAD` would report the twelve paths as a leak. The env overrides
 * exist so the mutation knives can point this at a throwaway branch instead of at `main`; the
 * defaults are what gets published.
 */
const PUBLIC_REF = process.env.POOF_PUBLIC_REF ?? 'main';
const COMPANY_REF = process.env.POOF_COMPANY_REF ?? 'internal-deploy';

/**
 * Written out rather than derived from the two lines' difference, because a list derived from the
 * thing under test cannot complain when that thing changes. Judgement 4 is what keeps this list
 * from rotting: it collides the list against the real company-only set on every run.
 */
const COMPANY_ONLY_PATHS = [
  '.dockerignore',
  '.gitlab-ci.yml',
  'Dockerfile',
  'deploy/k3s-deployer-rbac.yaml',
  'docker/base/Dockerfile',
  'docker/base/README.md',
  'docker/base/verify.sh',
  'docs/DEPLOY-K3S.md',
  'k8s/deployment.yaml',
  'k8s/pvc.yaml',
  'k8s/service.yaml',
  'scripts/check-company-config.mjs'
];

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** `git grep` exits 1 for "nothing matched", which is an answer. Anything else must not read as clean. */
function gitGrepList(pattern: string, ref: string): string[] {
  let out: string;
  try {
    out = git(['grep', '-l', '-I', '-i', '-e', pattern, ref]);
  } catch (err) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  return out.split('\n').filter(Boolean).map((line) => line.slice(line.indexOf(':') + 1));
}

function trackedFiles(ref: string): string[] {
  return git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);
}

function refExists(ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

const hasCompanyLine = refExists(COMPANY_REF);

/**
 * A bracket class, not the literal. This file is tracked on the public line, so writing the string
 * plainly would trip judgement 2 on the very commit that adds the guard -- the scan must not contain
 * what it hunts.
 */
const HOST_FRAGMENT = 'l[h]cz';

describe('the public line carries no company deployment configuration', () => {
  it('1. none of the company-only paths is tracked on the public ref', () => {
    const files = trackedFiles(PUBLIC_REF);
    // A guard that reads an empty tree passes on nothing, so the subject has to be a tree at all.
    expect(files.length, `${PUBLIC_REF} resolves to ${files.length} files - not a publishable tree`).toBeGreaterThan(50);
    expect(files.filter((f) => COMPANY_ONLY_PATHS.includes(f))).toEqual([]);
  });

  it('2. no tracked file on the public ref names the company host', () => {
    expect(trackedFiles(PUBLIC_REF).length).toBeGreaterThan(50);
    expect(gitGrepList(HOST_FRAGMENT, PUBLIC_REF)).toEqual([]);
  });
});

describe('the leak scan has teeth', () => {
  it.skipIf(!hasCompanyLine)('3. the same content scan does find the host on the company line', () => {
    const hits = gitGrepList(HOST_FRAGMENT, COMPANY_REF);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain('.gitlab-ci.yml');
  });

  it.skipIf(!hasCompanyLine)('4. every company-only path is named in the written list', () => {
    const added = git(['diff', '--diff-filter=A', '--name-only', PUBLIC_REF, COMPANY_REF]).split('\n').filter(Boolean);
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((p) => !COMPANY_ONLY_PATHS.includes(p))).toEqual([]);
  });
});
