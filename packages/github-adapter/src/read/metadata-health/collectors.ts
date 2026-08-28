/**
 * C014 §12/§23 step 4 — bounded, conditional, single-flight-aware field
 * collection. Each field is read through the provider port; conditional 304s
 * advance freshness without replacing values; failures become typed
 * field-level errors and never lose previously observed values.
 */
import type {
  CiDescriptor,
  EffectivePermissions,
  FieldFailure,
  LanguageCount,
  MetadataField,
  RepositoryMetadataSnapshot,
  ResourceEtag,
} from './contracts.js';
import type {
  ActivityObservation,
  IdentityObservation,
  ProviderReadContext,
  RepositoryMetadataProviderPort,
} from './provider-port.js';

export interface CollectedFields {
  readonly attemptedFields: readonly MetadataField[];
  /**
   * Fields freshly confirmed this cycle — either a successful value read or a
   * 304 not-modified that re-validated the cached value. Retained (carried
   * forward) fields are NOT included so downstream health/validity decisions
   * can distinguish "re-observed now" from "copied from an older snapshot".
   */
  readonly freshlyObserved: readonly MetadataField[];
  readonly identity?: IdentityObservation | undefined;
  readonly languages?: readonly LanguageCount[] | undefined;
  readonly permissions?: EffectivePermissions | undefined;
  readonly activity?: ActivityObservation | undefined;
  readonly ciDescriptors?: readonly CiDescriptor[] | undefined;
  readonly resourceEtags: readonly ResourceEtag[];
  readonly fieldFailures: readonly FieldFailure[];
  readonly sourceRequestIds: readonly string[];
  readonly anySuccess: boolean;
  readonly rateLimited: boolean;
  readonly retryAfterMs?: number | undefined;
  readonly unreachable: boolean;
}

export interface CollectOptions {
  readonly ownerLogin: string;
  readonly repoName: string;
  readonly defaultBranch: string;
  readonly fields: readonly MetadataField[];
  readonly previous?: RepositoryMetadataSnapshot | undefined;
  readonly ctx: ProviderReadContext;
  readonly maxConcurrency: number;
}

/**
 * Runs `jobs` with at most `limit` concurrent promises (bounded fan-out,
 * C014 §19). Deterministic ordering of results is preserved by index.
 */
async function mapWithConcurrency<T>(
  jobs: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      if (job === undefined) return;
      results[index] = await job();
    }
  });
  await Promise.all(workers);
  return results;
}

function etagFor(
  previous: RepositoryMetadataSnapshot | undefined,
  field: MetadataField,
): string | undefined {
  if (!previous) return undefined;
  for (const entry of previous.resourceEtags) {
    if (entry.resource === field) return entry.etag;
  }
  return undefined;
}

/**
 * Collects the requested fields with conditional requests and bounded
 * concurrency. Successful values replace previous ones; 304s and failures
 * retain previous values so a provider outage can never blank a snapshot.
 */
export class MetadataCollector {
  constructor(private readonly provider: RepositoryMetadataProviderPort) {}

  async collect(options: CollectOptions): Promise<CollectedFields> {
    const sourceRequestIds: string[] = [];
    const resourceEtags: ResourceEtag[] = [];
    const fieldFailures: FieldFailure[] = [];
    const freshlyObserved: MetadataField[] = [];
    const fresh: Partial<Record<MetadataField, unknown>> = {};
    let anySuccess = false;
    let rateLimited = false;
    let retryAfterMs: number | undefined;
    let unreachable = false;

    const jobs = options.fields.map((field) => async () => {
      const ifNoneMatch = etagFor(options.previous, field);
      sourceRequestIds.push(`${options.ctx.operationKey}:${field}`);
      const result = await this.#readField(field, ifNoneMatch, options);
      if (result.kind === 'not-modified') {
        anySuccess = true;
        freshlyObserved.push(field);
        resourceEtags.push({
          resource: field,
          etag: result.etag,
          ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
        });
        return;
      }
      if (result.kind === 'failed') {
        if (result.code === 'RATE_LIMITED') {
          rateLimited = true;
          retryAfterMs = result.retryAfterMs;
          fieldFailures.push({
            field,
            reasonCode: 'RATE_LIMITED',
            detail: 'rate limit budget exhausted',
          });
          return;
        }
        if (
          result.code === 'SERVER_ERROR' ||
          result.code === 'TIMEOUT' ||
          result.code === 'AUTHENTICATION'
        ) {
          unreachable = true;
        }
        fieldFailures.push({
          field,
          reasonCode: result.code === 'NOT_FOUND' ? 'NOT_FOUND' : result.code,
          detail: 'provider read failed with typed error',
        });
        return;
      }
      anySuccess = true;
      freshlyObserved.push(field);
      fresh[field] = result.value;
      resourceEtags.push({
        resource: field,
        etag: result.etag,
        ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
      });
    });

    await mapWithConcurrency(jobs, options.maxConcurrency);

    const previous = options.previous;
    return {
      attemptedFields: [...options.fields],
      freshlyObserved,
      identity:
        (fresh['identity'] as IdentityObservation | undefined) ??
        (previous ? identityFromSnapshot(previous) : undefined),
      languages:
        (fresh['languages'] as readonly LanguageCount[] | undefined) ?? previous?.languages,
      permissions:
        (fresh['permissions'] as EffectivePermissions | undefined) ??
        previous?.effectivePermissions,
      activity:
        (fresh['activity'] as ActivityObservation | undefined) ??
        (previous ? activityFromSnapshot(previous) : undefined),
      ciDescriptors:
        (fresh['checks'] as readonly CiDescriptor[] | undefined) ?? previous?.ciDescriptors,
      resourceEtags,
      fieldFailures,
      sourceRequestIds,
      anySuccess,
      rateLimited,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      unreachable,
    };
  }

  async #readField(
    field: MetadataField,
    ifNoneMatch: string | undefined,
    options: CollectOptions,
  ): Promise<
    | {
        kind: 'value';
        value: unknown;
        etag?: string | undefined;
        lastModified?: string | undefined;
      }
    | { kind: 'not-modified'; etag?: string | undefined; lastModified?: string | undefined }
    | { kind: 'failed'; code: string; retryAfterMs?: number | undefined }
  > {
    const input = {
      ownerLogin: options.ownerLogin,
      repoName: options.repoName,
      ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
    };
    let result;
    switch (field) {
      case 'identity':
        result = await this.provider.readIdentity(input, options.ctx);
        break;
      case 'default_branch':
        // Default-branch resolution is part of identity observation; the
        // identity read must succeed for a workflow-critical branch value.
        result = await this.provider.readIdentity(input, options.ctx);
        break;
      case 'languages':
        result = await this.provider.readLanguages(input, options.ctx);
        break;
      case 'permissions':
        result = await this.provider.readEffectivePermissions(
          { ownerLogin: options.ownerLogin, repoName: options.repoName },
          options.ctx,
        );
        break;
      case 'activity':
        result = await this.provider.readRecentActivity(input, options.ctx);
        break;
      case 'checks':
        result = await this.provider.readCiDescriptors(
          {
            ownerLogin: options.ownerLogin,
            repoName: options.repoName,
            defaultBranch: options.defaultBranch,
            ...(ifNoneMatch !== undefined ? { ifNoneMatch } : {}),
          },
          options.ctx,
        );
        break;
    }
    if (result === undefined) {
      return { kind: 'failed', code: 'SERVER_ERROR' };
    }
    if (!result.ok) {
      return {
        kind: 'failed',
        code: result.code,
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      };
    }
    if (result.notModified) {
      return {
        kind: 'not-modified',
        etag: result.etag,
        ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
      };
    }
    return {
      kind: 'value',
      value: result.value,
      etag: result.etag,
      ...(result.lastModified !== undefined ? { lastModified: result.lastModified } : {}),
    };
  }
}

function identityFromSnapshot(snapshot: RepositoryMetadataSnapshot): IdentityObservation {
  return {
    githubRepositoryId: snapshot.githubRepositoryId,
    ownerLogin: snapshot.ownerLogin,
    repoName: snapshot.repoName,
    fullName: snapshot.fullName,
    defaultBranch: snapshot.defaultBranch,
    visibility: snapshot.visibility,
    archived: snapshot.archived,
    disabled: snapshot.disabled,
    fork: snapshot.fork,
  };
}

function activityFromSnapshot(snapshot: RepositoryMetadataSnapshot): ActivityObservation {
  return {
    ...(snapshot.pushedAtIso !== undefined ? { pushedAtIso: snapshot.pushedAtIso } : {}),
    ...(snapshot.providerUpdatedAtIso !== undefined
      ? { providerUpdatedAtIso: snapshot.providerUpdatedAtIso }
      : {}),
    ...(snapshot.latestObservedSha !== undefined
      ? { latestObservedSha: snapshot.latestObservedSha }
      : {}),
  };
}
