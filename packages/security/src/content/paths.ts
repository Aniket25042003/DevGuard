/**
 * C095 — Path canonicalization and root confinement (PathGuard).
 *
 * Two layers:
 * 1. PURE lexical normalization: rejects NULs, backslash separators, absolute
 *    paths, Windows drives/UNC, percent/double encodings that hide traversal,
 *    Unicode confusables after NFC normalization, trailing dots/spaces,
 *    reserved device names, and resolves '.'/'..' virtually — any escape of
 *    the virtual root is rejected BEFORE touching the filesystem.
 * 2. OPTIONAL real-FS identity check: walks components with lstat and refuses
 *    symlinks/links/devices; verifies the final absolute path stays inside the
 *    canonicalized root. Descriptor-relative no-follow operations are the
 *    sandbox provider's obligation (C042/C043 contract).
 */
import { promises as nodeFs } from 'node:fs';
import path from 'node:path';
import { makeError } from '@devguard/errors';

export interface ContentBudget {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxLines: number;
  readonly maxDepth: number;
  readonly maxArchiveRatio: number;
  readonly maxPatchFiles: number;
  readonly maxPatchHunks: number;
  readonly deadlineMs: number;
}

export const DEFAULT_BUDGET: ContentBudget = Object.freeze({
  maxFiles: 500,
  maxFileBytes: 10_000_000,
  maxTotalBytes: 50_000_000,
  maxLines: 20_000,
  maxDepth: 16,
  maxArchiveRatio: 100,
  maxPatchFiles: 100,
  maxPatchHunks: 2_000,
  deadlineMs: 60_000,
});

export function contentBudget(overrides: Partial<ContentBudget> = {}): ContentBudget {
  return { ...DEFAULT_BUDGET, ...overrides };
}

export interface SafePathShape {
  readonly rootId: string;
  /** Normalized, root-relative, '/'-separated; never starts with '/'. */
  readonly normalizedRelativePath: string;
  readonly kind: 'file' | 'directory';
}

const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`),
]);

const PERCENT_ENCODING = /%[0-9a-fA-F]{2}/;

function fail(reasonCode: string): never {
  throw makeError('PATH_ACCESS_BLOCKED', { details: { reasonCode }, cause: new Error(reasonCode) });
}

/** Pure lexical layer. Throws PATH_ACCESS_BLOCKED on ANY violation. */
export function normalizeRelativePath(rootId: string, rawInput: string): SafePathShape {
  if (rawInput.includes('\u0000')) fail('nul_byte');
  // Backslashes are rejected outright: alternate separators are an attack vector.
  if (rawInput.includes('\\')) fail('alternate_separator');
  if (path.posix.isAbsolute(rawInput) || rawInput.startsWith('/')) fail('absolute_path');
  if (/^[a-zA-Z]:/.test(rawInput)) fail('windows_drive');
  if (rawInput.startsWith('//') || rawInput.startsWith('\\\\')) fail('unc_path');

  let candidate = rawInput;
  // Percent decoding must not reveal traversal or NUL: decode once, re-scan.
  if (PERCENT_ENCODING.test(candidate)) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      fail('invalid_encoding');
    }
    if (candidate.includes('\u0000')) fail('nul_byte_after_decode');
    if (PERCENT_ENCODING.test(candidate)) fail('double_encoding');
    if (candidate.includes('..') || candidate.includes('\\')) {
      fail('encoded_traversal');
    }
  }

  // Unicode normalization: confusables that normalize into separators/traversal.
  const normalizedUnicode = candidate.normalize('NFC');
  if (normalizedUnicode !== candidate && /[\u2044\u2215]/.test(normalizedUnicode)) {
    fail('unicode_separator_confusable');
  }

  const segments = normalizedUnicode.split('/');
  const resolvedSegments: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolvedSegments.length === 0) fail('traversal_above_root');
      resolvedSegments.pop();
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F]/.test(segment)) fail('control_characters');
    if (/[.\s]$/.test(segment)) fail('trailing_dot_or_space');
    const baseName = segment.split('.')[0] ?? '';
    if (
      RESERVED_DEVICE_NAMES.has(segment.toUpperCase()) ||
      RESERVED_DEVICE_NAMES.has(baseName.toUpperCase())
    ) {
      fail('reserved_device_name');
    }
    if (segment.length > 255) fail('segment_too_long');
    resolvedSegments.push(segment);
  }
  if (resolvedSegments.length === 0) fail('empty_path');

  const normalizedRelativePath = resolvedSegments.join('/');
  return { rootId, normalizedRelativePath, kind: 'file' };
}

/** Real-FS identity check (layer 2). fs injectable for tests. */
export async function resolveWorkspacePath(
  rootId: string,
  rawInput: string,
  options: {
    readonly rootDir: string;
    readonly fs?: Pick<typeof nodeFs, 'lstat'> | undefined;
  },
): Promise<SafePathShape> {
  const safe = normalizeRelativePath(rootId, rawInput);
  const filesystem = options.fs ?? nodeFs;

  // Root canonicalized once per call (callers may cache by rootDir).
  const realRoot = await filesystem.lstat(options.rootDir).then((stats) => stats);
  if (realRoot.isSymbolicLink()) fail('root_is_symlink');

  const rootAbsolute = path.resolve(options.rootDir);
  const targetAbsolute = path.resolve(rootAbsolute, safe.normalizedRelativePath);
  if (!targetAbsolute.startsWith(rootAbsolute + path.sep) && targetAbsolute !== rootAbsolute) {
    fail('resolved_escape');
  }

  // Walk components with lstat: refuse symlinks anywhere along the way.
  let walked = rootAbsolute;
  for (const segment of safe.normalizedRelativePath.split('/')) {
    walked = path.join(walked, segment);
    try {
      const stats = await filesystem.lstat(walked);
      if (stats.isSymbolicLink()) fail('symlink_component');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; // not-yet-created leaf is fine
      throw error;
    }
  }
  return safe;
}
