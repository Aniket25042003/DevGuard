#!/usr/bin/env node
/**
 * C100 — Deployment preflight (non-destructive, no provider writes).
 *
 * Aggregates the checks a deployment needs before it may claim readiness:
 * immutable release evidence (manifest), required secret REFERENCE vars present
 * (values never printed), and docker/compose availability. Missing required
 * config yields `blocked`; a malformed release manifest yields `failed`. An
 * unknown/partial result is never reported as `${:?}` `passed`.
 *
 * Usage:
 *   node scripts/deploy/preflight.mjs [path-to-release-manifest.json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const REQUIRED_CONFIG = [
  'DEVGUARD_DB_DSN',
  'DEVGUARD_REDIS_URL',
  'DEVGUARD_SECRET_REF_GITHUB_APP_KEY',
  'DEVGUARD_SECRET_REF_TRUEFORGE_KEY',
];

function runProbe(command) {
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 15_000 });
  return { ok: result.status === 0, detail: result.stdout?.trim() ?? '' };
}

const checks = [];

for (const key of REQUIRED_CONFIG) {
  const present =
    (process.env[key] !== undefined && process.env[key] !== null && process.env[key] !== '') ??
    false;
  checks.push({
    name: `config.${key}`,
    ok: present,
    detail: present ? 'present (value hidden)' : 'missing reference',
  });
}

const docker = runProbe(['docker', 'info', '--format', '{{.ServerVersion}}']);
checks.push({ name: 'docker', ok: docker.ok, detail: docker.detail || 'unavailable' });

const manifestPath = process.argv[2];
let manifest;
if (manifestPath) {
  if (!existsSync(manifestPath)) {
    checks.push({ name: 'release.manifest', ok: false, detail: 'manifest path missing' });
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      checks.push({
        name: 'release.manifest',
        ok: manifest?.gitSha?.length === 40,
        detail: 'parsed',
      });
    } catch {
      checks.push({ name: 'release.manifest', ok: false, detail: 'unparseable JSON' });
    }
  }
} else {
  checks.push({ name: 'release.manifest', ok: false, detail: 'no manifest provided (blocked)' });
}

const failed = checks.filter((c) => !c.ok);
const status = failed.some((c) => c.name === 'release.manifest')
  ? 'failed'
  : failed.length > 0
    ? 'blocked'
    : 'passed';

console.log(JSON.stringify({ status, checks, failed: failed.map((c) => c.name) }, null, 2));
