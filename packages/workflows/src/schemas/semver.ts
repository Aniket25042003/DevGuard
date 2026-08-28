/**
 * C045 §8/§23.3 — semantic versioning for definitions, skills and schemas.
 *
 * Strict semver 2.0.0 subset: `major.minor.patch[-prerelease][+build]`.
 * Compatibility follows semver precedence: within the same major version a
 * definition is a drop-in (compatibility is a conservative ceiling); ranges
 * support exact, caret, tilde and wildcard forms. Pre-release versions never
 * satisfy a range unless the range itself names a pre-release (semver rule).
 */
import { z } from 'zod';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string | undefined;
  readonly build?: string | undefined;
}

/**
 * Strict semantic version (boundary: unknown/malformed versions fail closed).
 * The validated string is immediately normalized to the canonical `Semver`
 * object used across the domain; consumers render on demand via `versionOf`.
 */
export const semverSchema: z.ZodType<Semver> = z
  .string()
  .min(5)
  .max(64)
  .regex(SEMVER_PATTERN, 'expected semantic version major.minor.patch[-prerelease][+build]')
  .transform((value) => parseSemver(value));

const RANGE_PATTERN =
  /^(?:\*|(\d+)(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)?|\^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?|~(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Version ranges: exact (`1.2.3`), caret (`^1.2.3`), tilde (`~1.2.3`),
 * wildcard (`1.x`, `1.2.x`, `1`) and `*`.
 */
export const semverRangeSchema: z.ZodType<SemverRange> = z
  .string()
  .min(1)
  .max(64)
  .regex(RANGE_PATTERN, 'expected version range (exact, ^, ~, x-wildcard or *)')
  .transform((value) => value as SemverRange);

export type SemverRange = string & { readonly __semverRange: unique symbol };

export class SemverError extends Error {}

/** Parse a validated semver string; throws SemverError on malformed input. */
export function parseSemver(input: string): Semver {
  const match = SEMVER_PATTERN.exec(input);
  if (!match) {
    throw new SemverError(`invalid semantic version '${input}'`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4];
  const build = match[5];
  return {
    major,
    minor,
    patch,
    ...(prerelease !== undefined ? { prerelease } : {}),
    ...(build !== undefined ? { build } : {}),
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNum = /^\d+$/.test(left) ? Number(left) : Number.NaN;
  const rightNum = /^\d+$/.test(right) ? Number(right) : Number.NaN;
  if (!Number.isNaN(leftNum) && !Number.isNaN(rightNum)) {
    return leftNum === rightNum ? 0 : leftNum < rightNum ? -1 : 1;
  }
  if (Number.isNaN(leftNum) && !Number.isNaN(rightNum)) return 1; // numeric < alphanumeric
  if (!Number.isNaN(leftNum) && Number.isNaN(rightNum)) return -1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePrerelease(left: string | undefined, right: string | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1; // release > prerelease
  if (right === undefined) return -1;
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const max = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < max; i += 1) {
    const a = leftParts[i];
    const b = rightParts[i];
    if (a === undefined && b === undefined) continue;
    if (a === undefined) return -1; // shorter prerelease < longer
    if (b === undefined) return 1;
    const order = compareIdentifiers(a, b);
    if (order !== 0) return order;
  }
  return 0;
}

/** Compare two semvers: -1, 0 or 1 (build metadata does not affect order). */
export function compareSemver(left: Semver, right: Semver): -1 | 0 | 1 {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  const prerelease = comparePrerelease(left.prerelease, right.prerelease);
  return prerelease < 0 ? -1 : prerelease > 0 ? 1 : 0;
}

/** Highest of two versions (build metadata ignored). */
export function maxSemver(left: Semver, right: Semver): Semver {
  return compareSemver(left, right) >= 0 ? left : right;
}

interface ParsedRange {
  readonly kind: 'exact' | 'caret' | 'tilde' | 'wildcard' | 'any';
  readonly major: number;
  readonly minor?: number | undefined;
  readonly patch?: number | undefined;
  readonly prerelease?: string | undefined;
}

function parseRange(range: string): ParsedRange {
  const trimmed = range.trim();
  if (trimmed === '*') return { kind: 'any', major: 0 };
  const caret = /^\^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (caret) {
    return {
      kind: 'caret',
      major: Number(caret[1]),
      minor: Number(caret[2]),
      patch: Number(caret[3]),
      prerelease: caret[4],
    };
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (tilde) {
    return {
      kind: 'tilde',
      major: Number(tilde[1]),
      minor: Number(tilde[2]),
      patch: Number(tilde[3]),
      prerelease: tilde[4],
    };
  }
  const wildcard = /^(\d+)(?:\.(\d+|\*|x))?(?:\.(\d+|\*|x))?$/.exec(trimmed);
  if (wildcard) {
    const minorRaw = wildcard[2];
    const patchRaw = wildcard[3];
    return {
      kind: 'wildcard',
      major: Number(wildcard[1]),
      minor:
        minorRaw !== undefined && minorRaw !== '*' && minorRaw !== 'x'
          ? Number(minorRaw)
          : undefined,
      patch:
        patchRaw !== undefined && patchRaw !== '*' && patchRaw !== 'x'
          ? Number(patchRaw)
          : undefined,
    };
  }
  const exact = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (exact) {
    return {
      kind: 'exact',
      major: Number(exact[1]),
      minor: Number(exact[2]),
      patch: Number(exact[3]),
      prerelease: exact[4],
    };
  }
  throw new SemverError(`unsupported range '${range}'`);
}

function satisfiesFloor(version: Semver, spec: ParsedRange): boolean {
  const floorMinor = spec.minor ?? 0;
  const floorPatch = spec.patch ?? 0;
  if (version.minor !== floorMinor) return version.minor > floorMinor;
  return version.patch >= floorPatch;
}

/**
 * True when `version` satisfies `range` (exact/caret/tilde/wildcard/`*`).
 * Pre-release versions match only ranges that name the same pre-release.
 */
export function semverSatisfies(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  const spec = parseRange(range);
  if (spec.kind === 'any') return parsed.prerelease === undefined;
  if (parsed.major !== spec.major) return false;
  // Semver rule: pre-releases never satisfy a range without a pre-release.
  if (parsed.prerelease !== undefined) {
    if (spec.prerelease === undefined) return false;
    return (
      `${parsed.major}.${parsed.minor}.${parsed.patch}-${parsed.prerelease}` ===
      `${spec.major}.${spec.minor ?? 0}.${spec.patch ?? 0}-${spec.prerelease}`
    );
  }
  switch (spec.kind) {
    case 'exact':
      return (
        parsed.minor === (spec.minor ?? 0) &&
        parsed.patch === (spec.patch ?? 0) &&
        spec.prerelease === undefined
      );
    case 'caret':
      // ^1.2.3 := >=1.2.3 <2.0.0; ^0.2.3 := >=0.2.3 <0.3.0; ^0.0.3 := >=0.0.3 <0.0.4
      return satisfiesFloor(parsed, spec);
    case 'tilde':
      return parsed.minor === (spec.minor ?? 0) && parsed.patch >= (spec.patch ?? 0);
    case 'wildcard':
      if (spec.minor === undefined) return true; // any 1.x.x
      if (spec.patch === undefined) return parsed.minor === spec.minor; // any 1.2.x
      return parsed.minor === spec.minor && parsed.patch === spec.patch;
    default:
      return false;
  }
}
