#!/usr/bin/env node
/**
 * C099 §12 — trusted change detection (scope computation).
 *
 * Cross-cutting paths force the full required matrix so path filtering can
 * never silently skip security-critical suites. Output format:
 *   affected=<comma-separated-suite-list>
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CROSS_CUTTING = [
  'pnpm-lock.yaml',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig',
  '.github/',
  'tooling/',
  'scripts/',
  'infra/',
];

const SUITE_TRIGGERS = [
  {
    suites: ['integration'],
    paths: ['packages/db/', 'tests/integration/', 'infra/', 'scripts/local/'],
  },
  { suites: ['unit', 'typecheck', 'lint'], paths: ['packages/', 'apps/', 'tests/'] },
];

const eventName = process.argv[2] ?? 'pull_request';

function listChangedFiles() {
  // pull_request: compare against merge base; push: previous commit.
  try {
    const base =
      eventName === 'push'
        ? `${process.env['GITHUB_EVENT_BEFORE'] ?? 'HEAD~1'}`
        : process.env['GITHUB_BASE_REF']
          ? `origin/${process.env['GITHUB_BASE_REF']}`
          : 'HEAD~1';
    return execFileSync('git', ['diff', '--name-only', base, 'HEAD'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    // Detached/new repos: treat as full-change to stay fail-closed.
    return ['<all>'];
  }
}

export function computeAffected(files) {
  const full = files.some((f) => f === '<all>' || CROSS_CUTTING.some((p) => f.includes(p)));
  const affected = new Set(['changes', 'install-integrity']);
  if (full) {
    ['typecheck', 'lint', 'format', 'build', 'unit', 'integration'].forEach((s) => affected.add(s));
    return [...affected];
  }
  for (const trigger of SUITE_TRIGGERS) {
    if (files.some((f) => trigger.paths.some((p) => f.includes(p)))) {
      trigger.suites.forEach((s) => affected.add(s));
    }
  }
  return [...affected].sort();
}

const files = existsSync('.git') ? listChangedFiles() : ['<all>'];
console.log(`affected=${computeAffected(files).join(',')}`);
