#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const REQUIRED_CONFIG = ['DATABASE_URL', 'REDIS_URL', 'AUTH_SESSION_SECRET', 'AUTH_GITHUB_OAUTH_CLIENT_ID', 'AUTH_GITHUB_OAUTH_CLIENT_SECRET', 'AUTH_GITHUB_OAUTH_CALLBACK_URL', 'DEVGUARD_SECRET_REF_GITHUB_APP_KEY', 'DEVGUARD_SECRET_REF_TRUEFORGE_KEY'];
function runProbe(command) { const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 15_000 }); return { ok: result.status === 0, detail: result.stdout?.trim() ?? '' }; }
const checks = [];
for (const key of REQUIRED_CONFIG) { const present = Boolean(process.env[key]); checks.push({ name: `config.${key}`, ok: present, detail: present ? 'present (value hidden)' : 'missing reference' }); }
const docker = runProbe(['docker', 'info', '--format', '{{.ServerVersion}}']);
checks.push({ name: 'docker', ok: docker.ok, detail: docker.detail || 'unavailable' });
const manifestPath = process.argv[2];
if (!manifestPath) checks.push({ name: 'release.manifest', ok: false, detail: 'no manifest provided (blocked)' });
else if (!existsSync(manifestPath)) checks.push({ name: 'release.manifest', ok: false, detail: 'manifest path missing' });
else try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const valid = typeof manifest?.releaseId === 'string' && manifest.releaseId.length > 0 && /^[0-9a-f]{40}$/.test(manifest.gitSha) && /^sha256:[0-9a-f]{64}$/.test(manifest.imageDigest) && /^[0-9a-f]{64}$/.test(manifest.migrationSetHash) && Array.isArray(manifest.requiredChecks) && manifest.requiredChecks.length > 0 && new Set(['passed','failed','blocked','not_run']).has(manifest.providerContractStatus);
  checks.push({ name: 'release.manifest', ok: valid, detail: valid ? 'validated' : 'invalid manifest fields' });
} catch { checks.push({ name: 'release.manifest', ok: false, detail: 'unparseable JSON' }); }
const failed = checks.filter((c) => !c.ok);
const status = failed.some((c) => c.name === 'release.manifest') ? 'failed' : failed.length ? 'blocked' : 'passed';
console.log(JSON.stringify({ status, checks, failed: failed.map((c) => c.name) }, null, 2));
if (status !== 'passed') process.exitCode = 1;
