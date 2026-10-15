#!/usr/bin/env node
/**
 * The single place that answers "how new are the sources the artifact is supposed to be
 * built from". build-release stamps this into build-info.json, run-gates re-reads it, so a
 * package that was staged from an older dist can never be certified as current.
 */
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILES = ['next.config.js', 'package.json', 'tsconfig.json', 'tsconfig.server.json', 'ecosystem.config.cjs'];

function newestUnder(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      const ms = fs.statSync(p).mtimeMs;
      if (ms > newest) newest = ms;
    }
  }
  return newest;
}

export function sourceStamp(root) {
  let newest = newestUnder(path.join(root, 'src'));
  for (const f of CONFIG_FILES) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}

export function outputStamp(root) {
  const buildId = path.join(root, '.next', 'BUILD_ID');
  return Math.max(newestUnder(path.join(root, 'dist')), fs.existsSync(buildId) ? fs.statSync(buildId).mtimeMs : 0);
}
