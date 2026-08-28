#!/usr/bin/env node
/**
 * C100 — Release manifest validation (non-destructive).
 *
 * Validates a ReleaseManifest (C100 §8) so a deployment claim is only ever
 * accepted when the immutable evidence is present and well-formed. Any missing
 * or malformed field yields `status: 'failed'` (never coerced to passed).
 *
 * Usage:
 *   node scripts/deploy/release-manifest.mjs <path-to-manifest.json>
 * Emits a single JSON object on stdout and exits 0 on 'passed', 1 otherwise.
 */
import { readFileSync } from 'node:fs';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONTRACT_STATUSES = new Set(['passed', 'failed', 'blocked', 'not_run']);

function main() {
  const emit = (payload) => console.log(JSON.stringify(payload, null, 2));
  const fail = (reason) => {
    emit({ status: 'failed', reason });
    process.exitCode = 1;
    return false;
  };

  const manifestPath = process.argv[2];
  if (!manifestPath) return fail('usage: release-manifest.mjs <path-to-manifest.json>');

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return fail(`unreadable manifest: ${error.message}`);
  }

  const errors = [];
  if (typeof manifest?.releaseId !== 'string' || manifest.releaseId.length === 0)
    errors.push('releaseId required');
  if (typeof manifest?.gitSha !== 'string' || !GIT_SHA.test(manifest.gitSha))
    errors.push('gitSha must be a 40-char hex commit');
  if (typeof manifest?.imageDigest !== 'string' || !IMAGE_DIGEST.test(manifest.imageDigest))
    errors.push('imageDigest must be sha256:<64 hex>');
  if (typeof manifest?.migrationSetHash !== 'string' || !SHA256_HEX.test(manifest.migrationSetHash))
    errors.push('migrationSetHash must be 64-char hex');
  if (!Array.isArray(manifest?.requiredChecks) || manifest.requiredChecks.length === 0)
    errors.push('requiredChecks must be a non-empty array');
  if (!CONTRACT_STATUSES.has(manifest?.providerContractStatus))
    errors.push('providerContractStatus must be one of passed|failed|blocked|not_run');

  if (errors.length > 0) {
    emit({ status: 'failed', releaseId: manifest?.releaseId, errors });
    process.exitCode = 1;
    return;
  }

  emit({ status: 'passed', releaseId: manifest.releaseId });
}

main();
