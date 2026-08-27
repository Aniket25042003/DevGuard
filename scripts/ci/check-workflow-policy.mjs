#!/usr/bin/env node
/**
 * C099 — workflow-policy gate (supply-chain hardening for our own CI).
 *
 * Verifies across .github/workflows/*.y*ml (textual scan; YAML semantics are
 * GitHub's own responsibility):
 *  1. Every `uses:` is pinned to a full 40-hex commit SHA.
 *  2. Every workflow declares a top-level permissions block.
 *  3. Every job declares a `timeout-minutes`.
 * Fails closed with actionable messages.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const USES_SHA = /@[0-9a-f]{40}(\s|$)/;

export function lintWorkflowSource(fileName, source) {
  const problems = [];
  if (!source.includes('permissions:')) {
    problems.push(`${fileName}: missing top-level 'permissions:' block`);
  }
  const usesLines = source
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('- uses:') || l.trim().startsWith('uses:'));
  for (const line of usesLines) {
    if (!USES_SHA.test(line)) {
      problems.push(`${fileName}: unpinned action '${line.trim()}' (pin by full commit SHA)`);
    }
  }
  return problems;
}

/** Verify every top-level job declares a timeout via two-pass line scan. */
function lintJobTimeouts(fileName, source) {
  const problems = [];
  const jobsMatch = source.match(/^jobs:\n([\s\S]*)$/m);
  if (!jobsMatch) return [];
  const lines = jobsMatch[1].split(/\r?\n/);
  let current = null;
  let block = [];
  const flush = () => {
    if (!current) return;
    if (!block.some((l) => /^\s*timeout-minutes:\s*\d+/.test(l))) {
      problems.push(`${fileName}: job '${current}' lacks a timeout-minutes value`);
    }
  };
  for (const line of lines) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*(?:$|#.*)/.exec(line);
    if (header) {
      flush();
      current = header[1];
      block = [];
    } else if (current !== null) {
      block.push(line);
    }
  }
  flush();
  return problems;
}

export function lintWorkflowDirectory(dir = '.github/workflows') {
  const problems = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [`${dir}: directory not found`];
  }
  for (const entry of entries.filter((e) => e.endsWith('.yml') || e.endsWith('.yaml'))) {
    const file = path.join(dir, entry);
    const source = readFileSync(file, 'utf8');
    problems.push(...lintWorkflowSource(entry, source));
    problems.push(...lintJobTimeouts(path.basename(file), source));
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targetDir = process.argv[2];
  const found = targetDir ? lintWorkflowDirectory(targetDir) : lintWorkflowDirectory();
  for (const problem of found) console.error(`workflow-policy: ${problem}`);
  console.log(
    found.length === 0 ? 'workflow-policy: OK' : `workflow-policy: ${found.length} problem(s)`,
  );
  process.exit(found.length === 0 ? 0 : 1);
}
