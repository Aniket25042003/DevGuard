/**
 * C098 — pure helpers shared by the local orchestration CLI and its tests.
 * No side effects at import; all functions take explicit inputs.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Typed per-stage result contract from C098 §10. */
export const STAGE_STATUS = ['passed', 'failed', 'skipped', 'degraded'];

/**
 * @param {string} content raw key=value file content
 * @returns {Record<string, string>} parsed environment (comments ignored)
 */
export function parseDotEnv(content) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Create-if-absent .env.local derived from .env.example with the documented
 * local defaults. NEVER overwrites an existing file (C098 §20 idempotency).
 *
 * @param {string} repoRoot
 * @param {{examplePath?: string, targetPath?: string}} [paths]
 * @returns {{created: boolean, path: string}}
 */
export function bootstrapEnv(repoRoot, paths = {}) {
  const examplePath = path.resolve(repoRoot, paths.examplePath ?? '.env.example');
  const targetPath = path.resolve(repoRoot, paths.targetPath ?? '.env.local');
  if (!existsSync(examplePath)) {
    throw new Error(`Missing environment template '${examplePath}'`);
  }
  if (existsSync(targetPath)) {
    return { created: false, path: targetPath };
  }
  // Start from the committed template and inject truthful local service URLs.
  // Placeholders stay empty for anything provider-shaped (C098 §15/§16).
  const template = readFileSync(examplePath, 'utf8');
  const localDefaults = {
    DATABASE_URL: 'postgres://devguard_admin:devguard_admin_local@127.0.0.1:15432/devguard',
    REDIS_URL: 'redis://127.0.0.1:16379',
  };
  const lines = template
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([A-Z][A-Z0-9_]+)=.*$/.exec(line);
      if (!match) return line;
      return line.replace(/=.*$/, `=${localDefaults[match[1]] ?? ''}`);
    })
    .join('\n');
  // flag 'wx' fails if the file appeared concurrently; create-if-absent only.
  writeFileSync(targetPath, `${lines}\n`, { flag: 'wx' });
  return { created: true, path: targetPath };
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Destructive operations may only ever name a DevGuard-local disposable
 * target (C098 §17 reset safeguards). Rejects remote hosts and databases or
 * Compose projects that do not carry a dev/test identity marker.
 *
 * @param {string} databaseUrlOrName URL or database name to validate
 * @param {string[]} allowedNames explicit allowlist (e.g. devguard_test)
 * @throws when the target is not provably local-disposable
 */
export function assertLocalDisposableTarget(databaseUrlOrName, allowedNames = []) {
  let host = null;
  let dbName = String(databaseUrlOrName ?? '');
  try {
    const url = new URL(databaseUrlOrName);
    host = url.hostname;
    dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    // Plain database/project name form.
  }
  if (host && !LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing destructive action on non-local host '${host}'.`);
  }
  const markers = /(devguard|test|local|disposable)/i;
  const explicitlyAllowed = allowedNames.some((n) => n === dbName);
  if (!explicitlyAllowed && !markers.test(dbName)) {
    throw new Error(
      `Refusing destructive action on target '${dbName}' without a local dev/test identity marker.`,
    );
  }
  return { host, dbName };
}

/**
 * Prerequisite result shaping shared by doctor and the up flow.
 * @param {{name: string, ok: boolean, detail?: string}[]} checks
 */
export function summarizePrerequisites(checks) {
  const failed = checks.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    summary: failed.map((c) => `${c.name}: ${c.detail ?? 'unavailable'}`).join('; '),
  };
}

export { copyFileSync };
