import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Four places state a Node version floor and none of them read each other: `package.json` engines,
 * the CI matrix, the deployment table, and vite's own engines -- which is the one that decides
 * whether the test suite can load at all. That gap cost five red CI runs on the 20.9.0 arm with
 * `ERR_REQUIRE_ESM`, npm having printed `EBADENGINE` on the very first one. This file is the
 * collision; it does not decide what the floors should be, only that the same number is written
 * in every place that claims one.
 */
type Floor = [number, number, number];

function compare(a: Floor, b: Floor): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The lowest version a range can mean: `^20.19.0 || >=22.12.0` -> 20.19.0, `24.x` -> 24.0.0. */
function floorOf(text: string, where: string): Floor {
  // A wildcard arm means "anything in that family", so the honest floor is the family's bottom.
  const found = [...text.replace(/[xX*]/g, '0').matchAll(/(\d+)\.(\d+)(?:\.(\d+))?/g)].map(
    (m): Floor => [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
  );
  if (!found.length) throw new Error(`${where} contains no version number: ${JSON.stringify(text.slice(0, 120))}`);
  return found.reduce((lowest, v) => (compare(v, lowest) < 0 ? v : lowest));
}

function atLeast(version: Floor, floor: Floor): boolean {
  return compare(version, floor) >= 0;
}

function readJson(p: string): { engines?: Record<string, string> } {
  // A missing manifest is a failed check, not a passed one: this judgement's whole subject is
  // whether the toolchain's own floor is being honoured.
  return JSON.parse(fs.readFileSync(p, 'utf8')) as { engines?: Record<string, string> };
}

const productFloor = floorOf(String(readJson('package.json').engines?.node ?? ''), 'package.json engines.node');
const toolchainFloor = floorOf(String(readJson('node_modules/vite/package.json').engines?.node ?? ''), 'vite engines.node');

type Arm = { version: Floor; runsTests: boolean | null; label: string };

/**
 * The matrix spells its arms out as data (`node:` plus `tests:`) precisely so this file can read
 * the intent. A missing `tests:` is reported rather than defaulted, and it is reported *inside*
 * judgement 3 -- throwing here would redden the other two legs and make a knife unattributable.
 */
function parseArms(ciYaml: string): Arm[] {
  const lines = ciYaml.split('\n');
  const arms: Arm[] = [];
  lines.forEach((line, i) => {
    const label = /^\s*-\s+node:\s*'([^']+)'/.exec(line)?.[1];
    if (!label) return;
    let runsTests: boolean | null = null;
    for (let j = i + 1; j < lines.length && runsTests === null; j++) {
      const next = lines[j] ?? '';
      if (/^\s*-\s+node:/.test(next)) break;
      const flag = /^\s*tests:\s*(true|false)\s*$/.exec(next)?.[1];
      if (flag) runsTests = flag === 'true';
    }
    arms.push({ version: floorOf(label, `CI arm ${label}`), runsTests, label });
  });
  return arms;
}

function deploymentRow(): string {
  const row = /^.*\|\s*Node\.js\s*\|.*$/m.exec(fs.readFileSync('docs/DEPLOYMENT.md', 'utf8'))?.[0];
  if (!row) throw new Error('the deployment table no longer has a Node.js row for this judgement to read');
  return row;
}

function claim(row: string, label: string): Floor {
  const value = new RegExp(`${label}\\*\\* >= (\\d+\\.\\d+(?:\\.\\d+)?)`).exec(row)?.[1];
  if (!value) throw new Error(`the deployment table's Node.js row does not state a "${label}" floor`);
  return floorOf(value, `deployment ${label} claim`);
}

const ciYaml = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const arms = parseArms(ciYaml);

/**
 * This file reads the workflow with regexes, which cannot tell valid YAML from a file GitHub will
 * refuse to parse -- and one such line cost a run with zero jobs: a plain `run:` value containing
 * ": " is a mapping indicator landing in the middle of a value. So the shape itself is checked.
 * The safe forms are a block scalar (`|`, `>`) or a quoted scalar.
 */
function unsafePlainScalars(ciYaml: string): string[] {
  const bad: string[] = [];
  ciYaml.split('\n').forEach((line) => {
    const value = /^\s*(?:run|if):\s+(\S.*)$/.exec(line)?.[1];
    if (!value) return;
    if (/^[|>"']/.test(value)) return;
    if (value.includes(': ') || value.includes(' #')) bad.push(value.slice(0, 90));
  });
  return bad;
}

describe('the Node version floors agree across the four places that state one', () => {
  it('1. the deployment table promises the two floors that actually exist', () => {
    const row = deploymentRow();
    expect(claim(row, '运行')).toEqual(productFloor);
    expect(claim(row, '跑测试套件')).toEqual(toolchainFloor);
  });

  it('2. every CI arm is at or above the runtime floor, and one arm sits exactly on it', () => {
    expect(arms.length).toBeGreaterThanOrEqual(2);
    expect(arms.filter((a) => !atLeast(a.version, productFloor)).map((a) => a.label)).toEqual([]);
    // An arm on the floor is what makes ">= floor" a tested claim rather than an unexercised number.
    expect(arms.some((a) => compare(a.version, productFloor) === 0)).toBe(true);
  });

  it('3. each arm declares its intent, and runs the suite exactly when the toolchain can load there', () => {
    // An undeclared arm is how a suite quietly stops running somewhere, so a missing `tests:` is
    // its own failure rather than a default in either direction.
    expect(arms.filter((a) => a.runsTests === null).map((a) => a.label)).toEqual([]);
    const wrong = arms
      .filter((a) => a.runsTests !== atLeast(a.version, toolchainFloor))
      .map((a) => `${a.label}: tests=${String(a.runsTests)} but vite needs ${toolchainFloor.join('.')}`);
    expect(wrong).toEqual([]);
  });

  it('4. every run/if value is a form that cannot break the workflow parse', () => {
    // Zero jobs on a run is what "GitHub never accepted this file" looks like; the floors above
    // would all still read green here, so this shape gets its own leg.
    expect(unsafePlainScalars(ciYaml)).toEqual([]);
  });
});
