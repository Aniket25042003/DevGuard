/**
 * C015 §17 — repository-relative path canonicalization and safety.
 *
 * Paths are canonicalized before any tree matching or content fetch:
 * traversal (`..`), absolute paths, and NUL bytes are rejected at the
 * boundary (C015 §17: canonicalize paths, block traversal/symlink escape).
 */
import { makeError } from '@devguard/errors';

const VENDOR_DIR_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  'vendor',
  'coverage',
  '.tox',
  '.terraform',
  '.serverless',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'Pods',
  '.build',
  'DerivedData',
]);

const GENERATED_FILE_SEGMENTS = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'gradle.lockfile',
]);

/** Canonicalize a repository-relative path; throws PATH_ACCESS_BLOCKED. */
export function canonicalizeRepoPath(raw: string): string {
  if (raw.length === 0 || raw.length > 1024) {
    throw makeError('PATH_ACCESS_BLOCKED', {
      details: { reasonCode: 'INVALID_PATH_LENGTH' },
    });
  }
  if (raw.startsWith('/')) {
    throw makeError('PATH_ACCESS_BLOCKED', { details: { reasonCode: 'ABSOLUTE_PATH' } });
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw makeError('PATH_ACCESS_BLOCKED', { details: { reasonCode: 'PARENT_TRAVERSAL' } });
    }
    if (segment.includes('\0')) {
      throw makeError('PATH_ACCESS_BLOCKED', { details: { reasonCode: 'NUL_BYTE' } });
    }
    if (segment === '.') {
      throw makeError('PATH_ACCESS_BLOCKED', { details: { reasonCode: 'DOT_SEGMENT' } });
    }
  }
  const normalized = segments.join('/');
  return normalized;
}

/**
 * Deterministic vendor/generated filtering: skip directories where
 * scanning adds no understanding value and risks size bombs (C015 §17).
 */
export function isVendorOrGeneratedPath(path: string): boolean {
  const segments = path.split('/');
  for (const segment of segments) {
    if (VENDOR_DIR_SEGMENTS.has(segment)) return true;
  }
  const basename = segments[segments.length - 1];
  if (basename !== undefined && GENERATED_FILE_SEGMENTS.has(basename)) return true;
  return false;
}

/** Binary-ish or enormous-by-convention paths never enter the map. */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.mp3',
  '.wasm',
  '.class',
  '.jar',
  '.dll',
  '.so',
  '.dylib',
  '.exe',
  '.lockb',
]);

export function isBinaryPath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}
