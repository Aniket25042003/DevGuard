/**
 * C017 §8/§10 — contracts: capability registry, installation context, token
 * lease, and the redacted SecretString wrapper.
 *
 * SecretString is non-serializable by design: JSON.stringify produces
 * `[REDACTED:github-token]`, toString never exposes the value, and equality
 * is constant-time reference identity. Token values never appear in logs,
 * metrics, metrics labels, error messages, or structured output.
 */
export const GITHUB_CAPABILITIES = [
  'repository.metadata.read',
  'issue.read',
  'issue.comment.read',
  'content.read',
  'tree.read',
  'branch.read',
  'commit.read',
  'pull_request.read',
  'review.read',
  'check.read',
  'webhook.receive',
] as const;

export type GitHubCapability = (typeof GITHUB_CAPABILITIES)[number];

/**
 * C017 §23-2: capability-to-permission registry derived ONLY from verified
 * GitHub documentation (C017 §16 task 4). Unknown capabilities fail closed.
 */
export const CAPABILITY_PERMISSION_MAP: Readonly<Record<GitHubCapability, readonly string[]>> =
  Object.freeze({
    'repository.metadata.read': ['metadata: read'],
    'issue.read': ['issues: read'],
    'issue.comment.read': ['issues: read'],
    'content.read': ['contents: read'],
    'tree.read': ['contents: read'],
    'branch.read': ['contents: read'],
    'commit.read': ['contents: read'],
    'pull_request.read': ['pull_requests: read'],
    'review.read': ['pull_requests: read'],
    'check.read': ['checks: read'],
    'webhook.receive': [],
  });

export function requiredPermissionsFor(
  capabilities: readonly GitHubCapability[],
): readonly string[] {
  const set = new Set<string>();
  for (const capability of capabilities) {
    const permissions = CAPABILITY_PERMISSION_MAP[capability];
    if (!permissions) {
      // Fail closed: unknown capability.
      throw new Error(`unknown GitHub capability '${capability}'`);
    }
    for (const permission of permissions) set.add(permission);
  }
  return [...set].sort();
}

export interface InstallationContext {
  readonly installationId: string;
  readonly accountLogin: string;
  readonly targetType: 'Organization' | 'User';
  readonly repositorySelection: 'selected' | 'all';
  readonly status: 'active' | 'suspended';
  readonly permissions: readonly string[];
  readonly permissionsObservedAtIso: string;
}

export interface InstallationTokenLease {
  /** SecretString: non-serializable, never logged or persisted. */
  readonly token: SecretString;
  readonly expiresAtIso: string;
  readonly refreshAtIso: string;
  readonly installationId: string;
  readonly scopeDigest: string;
  readonly credentialVersion: string;
}

const TOKEN_REDACTED = '[REDACTED:github-token]';

export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** Raw value for transport injection only; never logged or serialized. */
  expose(): string {
    return this.#value;
  }

  toString(): string {
    return TOKEN_REDACTED;
  }

  toJSON(): string {
    return TOKEN_REDACTED;
  }

  get length(): number {
    return this.#value.length;
  }

  /** Constant-time-ish existence check (no value comparison). */
  get isEmpty(): boolean {
    return this.#value.length === 0;
  }
}

/** Round-trip helper for tests only. */
export function secretFrom(value: string): SecretString {
  return new SecretString(value);
}

// Scope digest: sha256 over sorted repo IDs + sorted permissions.
import { createHash } from 'node:crypto';

export function scopeDigest(
  githubRepositoryIds: readonly string[],
  capabilities: readonly GitHubCapability[],
): string {
  return createHash('sha256')
    .update(JSON.stringify([[...githubRepositoryIds].sort(), requiredPermissionsFor(capabilities)]))
    .digest('hex');
}
