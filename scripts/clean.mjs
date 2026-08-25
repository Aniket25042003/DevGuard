#!/usr/bin/env node
/** Remove build artifacts (dist, tsbuildinfo, coverage) without touching sources. */
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const removed = [];

for (const base of ['apps', 'packages', 'tests', '.']) {
  const abs = path.join(root, base);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (base === '.' && !entry.name.endsWith('.tsbuildinfo')) continue;
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'coverage') {
        removed.push(path.join(abs, entry.name));
      } else if (['apps', 'packages', 'tests'].includes(base)) {
        // Nested packages/packages/** trees are handled by the recursive walk below.
        collectNested(path.join(abs, entry.name));
      }
    } else if (entry.name.endsWith('.tsbuildinfo')) {
      removed.push(path.join(abs, entry.name));
    }
  }
}

function collectNested(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'coverage') removed.push(full);
      else collectNested(full);
    } else if (entry.name.endsWith('.tsbuildinfo')) {
      removed.push(full);
    }
  }
}

for (const target of removed) rmSync(target, { recursive: true, force: true });
console.log(`clean: removed ${removed.length} artifact location(s).`);
