/**
 * C014 §12/§23 step 2 — narrow normalized read port for metadata fields.
 *
 * Provider types stop here. A GitHub-backed implementation is verified and
 * wired in a later provider-gated step (C021); unit tests use deterministic
 * fakes. Every read returns per-resource conditional state (ETag /
 * Last-Modified) and an exact fetched-at timestamp; a `notModified` result
 * advances verified freshness without changing the field value.
 */
import type {
  CiDescriptor,
  EffectivePermissions,
  LanguageCount,
  MetadataField,
} from './contracts.js';

export type ProviderErrorCode =
  | 'NOT_FOUND'
  | 'PERMISSION'
  | 'AUTHENTICATION'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'SCHEMA_MISMATCH'
  | 'TIMEOUT';

export type ProviderReadResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly notModified?: false | undefined;
      readonly etag?: string | undefined;
      readonly lastModified?: string | undefined;
      readonly fetchedAtIso: string;
    }
  | {
      readonly ok: true;
      readonly notModified: true;
      readonly etag?: string | undefined;
      readonly lastModified?: string | undefined;
      readonly fetchedAtIso: string;
    }
  | {
      readonly ok: false;
      readonly code: ProviderErrorCode;
      readonly detail: string;
      readonly fetchedAtIso: string;
      readonly retryAfterMs?: number | undefined;
    };

export interface IdentityObservation {
  readonly githubRepositoryId: number;
  readonly ownerLogin: string;
  readonly repoName: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private';
  readonly archived: boolean;
  readonly disabled: boolean;
  readonly fork: boolean;
}

export interface ActivityObservation {
  readonly pushedAtIso?: string | undefined;
  readonly providerUpdatedAtIso?: string | undefined;
  readonly latestObservedSha?: string | undefined;
}

export interface ProviderReadContext {
  readonly correlationId: string;
  readonly operationKey: string;
}

/**
 * Conditional-request-capable provider reads (C014 §18 rate/conditional
 * behavior). `ifNoneMatch`/`ifModifiedSince` are passed through so a 304 can
 * advance freshness without re-fetching.
 */
export interface RepositoryMetadataProviderPort {
  readIdentity(
    input: { ownerLogin: string; repoName: string; ifNoneMatch?: string | undefined },
    ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<IdentityObservation>>;
  readLanguages(
    input: { ownerLogin: string; repoName: string; ifNoneMatch?: string | undefined },
    ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<readonly LanguageCount[]>>;
  readEffectivePermissions(
    input: { ownerLogin: string; repoName: string },
    ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<EffectivePermissions>>;
  readRecentActivity(
    input: { ownerLogin: string; repoName: string; ifNoneMatch?: string | undefined },
    ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<ActivityObservation>>;
  readCiDescriptors(
    input: {
      ownerLogin: string;
      repoName: string;
      defaultBranch: string;
      ifNoneMatch?: string | undefined;
    },
    ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<readonly CiDescriptor[]>>;
  /** Per-field success/failure recorded for the bounded fan-out (C014 §12). */
  readonly supportedFields: readonly MetadataField[];
}

/** Rate-limit surfaced to the refresh coordinator (C014 §18). */
export interface ProviderRateState {
  readonly limited: boolean;
  readonly retryAfterMs: number;
}

/**
 * Deterministic in-memory provider used by unit tests. Configured field
 * behaviors let tests exercise 304s, partial failures, rate limits, and
 * repeated refresh recovery without any network.
 */
export class InMemoryMetadataProvider implements RepositoryMetadataProviderPort {
  readonly supportedFields: readonly MetadataField[] = [
    'identity',
    'default_branch',
    'languages',
    'permissions',
    'activity',
    'checks',
  ];

  identity: IdentityObservation = {
    githubRepositoryId: 1001,
    ownerLogin: 'octo',
    repoName: 'demo',
    fullName: 'octo/demo',
    defaultBranch: 'main',
    visibility: 'private',
    archived: false,
    disabled: false,
    fork: false,
  };
  languages: readonly LanguageCount[] = [{ name: 'TypeScript', bytes: 42_000 }];
  permissions: EffectivePermissions = { kind: 'write', canPush: true };
  activity: ActivityObservation = {
    pushedAtIso: '2026-01-02T00:00:00.000Z',
    latestObservedSha: 'a'.repeat(40),
  };
  ciDescriptors: readonly CiDescriptor[] = [
    { name: 'CI', kind: 'workflow_run', externalKey: 'ci.yml' },
  ];
  /** Per-field failure configuration: field -> error code to fail with. */
  failingFields: Readonly<Partial<Record<MetadataField, ProviderErrorCode>>> = {};
  rateLimited = false;
  retryAfterMs = 30_000;
  lastSeenIfNoneMatch: Readonly<Record<string, string | undefined>> = {};

  async #run<T>(
    field: MetadataField,
    ifNoneMatch: string | undefined,
    build: () => T,
  ): Promise<ProviderReadResult<T>> {
    if (this.rateLimited) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        detail: 'rate limit budget exhausted (fake)',
        fetchedAtIso: new Date().toISOString(),
        retryAfterMs: this.retryAfterMs,
      };
    }
    this.lastSeenIfNoneMatch = { ...this.lastSeenIfNoneMatch, [field]: ifNoneMatch };
    const failure = this.failingFields[field];
    if (failure) {
      return {
        ok: false,
        code: failure,
        detail: `fake failure for ${field}`,
        fetchedAtIso: new Date().toISOString(),
      };
    }
    const etag = `"etag-${field}"`;
    if (ifNoneMatch === etag) {
      return {
        ok: true,
        notModified: true,
        etag,
        fetchedAtIso: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      value: build(),
      etag,
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async readIdentity(
    input: { ownerLogin: string; repoName: string; ifNoneMatch?: string | undefined },
    _ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<IdentityObservation>> {
    return this.#run('identity', input.ifNoneMatch, () => ({ ...this.identity }));
  }

  async readLanguages(
    input: { ownerLogin: string; repoName: string; ifNoneMatch?: string | undefined },
    _ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<readonly LanguageCount[]>> {
    return this.#run('languages', input.ifNoneMatch, () => [...this.languages]);
  }

  async readEffectivePermissions(
    _input: { ownerLogin: string; repoName: string },
    _ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<EffectivePermissions>> {
    return this.#run('permissions', undefined, () => ({ ...this.permissions }));
  }

  async readRecentActivity(
    input: { ownerLogin: string; repoName: string; ifNoneMatch?: string | undefined },
    _ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<ActivityObservation>> {
    return this.#run('activity', input.ifNoneMatch, () => ({
      pushedAtIso: this.activity.pushedAtIso,
      ...(this.activity.providerUpdatedAtIso !== undefined
        ? { providerUpdatedAtIso: this.activity.providerUpdatedAtIso }
        : {}),
      ...(this.activity.latestObservedSha !== undefined
        ? { latestObservedSha: this.activity.latestObservedSha }
        : {}),
    }));
  }

  async readCiDescriptors(
    input: {
      ownerLogin: string;
      repoName: string;
      defaultBranch: string;
      ifNoneMatch?: string | undefined;
    },
    _ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<readonly CiDescriptor[]>> {
    return this.#run('checks', input.ifNoneMatch, () => [...this.ciDescriptors]);
  }

  rateState(): ProviderRateState {
    return { limited: this.rateLimited, retryAfterMs: this.retryAfterMs };
  }
}
