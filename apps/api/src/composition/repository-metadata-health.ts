/**
 * C014 — lifecycle-backed metadata provider for API health reads.
 */
import type {
  CiDescriptor,
  EffectivePermissions,
  IdentityObservation,
  LanguageCount,
  ProviderReadContext,
  ProviderReadResult,
  RepositoryMetadataProviderPort,
} from '@devguard/github-adapter';
import type { LifecycleReadPort } from '@devguard/github-adapter';

export interface LifecycleLookupPort extends LifecycleReadPort {
  getRecordByOwnerRepo(
    ownerLogin: string,
    repoName: string,
  ): Promise<
    | {
        readonly githubRepositoryId: number;
        readonly ownerLogin: string;
        readonly repoName: string;
        readonly fullName: string;
        readonly defaultBranch: string;
        readonly visibility: 'public' | 'private';
        readonly status: 'connected' | 'degraded' | 'disconnected';
      }
    | undefined
  >;
}

export class LifecycleLinkedMetadataProvider implements RepositoryMetadataProviderPort {
  readonly supportedFields = ['identity', 'permissions'] as const;

  constructor(private readonly lifecycle: LifecycleLookupPort) {}

  async #recordFor(
    ownerLogin: string,
    repoName: string,
  ): Promise<IdentityObservation | undefined> {
    const rows = await this.lifecycle.getRecordByOwnerRepo(ownerLogin, repoName);
    if (rows === undefined) return undefined;
    return {
      githubRepositoryId: rows.githubRepositoryId,
      ownerLogin: rows.ownerLogin,
      repoName: rows.repoName,
      fullName: rows.fullName,
      defaultBranch: rows.defaultBranch,
      visibility: rows.visibility,
      archived: false,
      disabled: rows.status === 'disconnected',
      fork: false,
    };
  }

  async readIdentity(
    input: { ownerLogin: string; repoName: string },
    _ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<IdentityObservation>> {
    const value = await this.#recordFor(input.ownerLogin, input.repoName);
    const fetchedAtIso = new Date().toISOString();
    if (value === undefined) {
      return { ok: false, code: 'NOT_FOUND', detail: 'repository linkage missing', fetchedAtIso };
    }
    return { ok: true, value, fetchedAtIso };
  }

  async readLanguages(): Promise<ProviderReadResult<readonly LanguageCount[]>> {
    return {
      ok: false,
      code: 'SERVER_ERROR',
      detail: 'languages_not_wired_on_api',
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async readEffectivePermissions(
    input: { ownerLogin: string; repoName: string },
    _ctx: ProviderReadContext,
  ): Promise<ProviderReadResult<EffectivePermissions>> {
    const record = await this.lifecycle.getRecordByOwnerRepo(input.ownerLogin, input.repoName);
    const fetchedAtIso = new Date().toISOString();
    if (record === undefined) {
      return { ok: false, code: 'NOT_FOUND', detail: 'repository linkage missing', fetchedAtIso };
    }
    return {
      ok: true,
      fetchedAtIso,
      value: {
        kind: record.status === 'connected' ? 'read' : 'read',
        canPush: false,
      },
    };
  }

  async readRecentActivity(): Promise<
    ProviderReadResult<{ pushedAtIso?: string | undefined; providerUpdatedAtIso?: string | undefined }>
  > {
    return {
      ok: false,
      code: 'SERVER_ERROR',
      detail: 'activity_not_wired_on_api',
      fetchedAtIso: new Date().toISOString(),
    };
  }

  async readCiDescriptors(): Promise<ProviderReadResult<readonly CiDescriptor[]>> {
    return {
      ok: false,
      code: 'SERVER_ERROR',
      detail: 'checks_not_wired_on_api',
      fetchedAtIso: new Date().toISOString(),
    };
  }
}

export class DurableLifecycleReadPort implements LifecycleLookupPort {
  constructor(
    private readonly pool: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async getRecord(repositoryDevguardId: string) {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT id, github_repository_id, installation_id, owner, name, full_name,
        default_branch, status FROM repositories WHERE id = $1`,
      values: [repositoryDevguardId],
    });
    const row = rows[0];
    if (row === undefined) return undefined;
    return this.#map(row);
  }

  async getRecordByOwnerRepo(ownerLogin: string, repoName: string) {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT id, github_repository_id, installation_id, owner, name, full_name,
        default_branch, status FROM repositories WHERE owner = $1 AND name = $2`,
      values: [ownerLogin, repoName],
    });
    const row = rows[0];
    if (row === undefined) return undefined;
    return this.#map(row);
  }

  #map(row: Record<string, unknown>) {
    const status = String(row['status']);
    return {
      id: String(row['id']),
      repositoryDevguardId: String(row['id']),
      githubRepositoryId: Number(row['github_repository_id']),
      installationId: String(row['installation_id']),
      ownerLogin: String(row['owner']),
      repoName: String(row['name']),
      fullName: String(row['full_name']),
      defaultBranch: String(row['default_branch'] ?? 'main'),
      visibility: 'private' as const,
      status:
        status === 'active'
          ? ('connected' as const)
          : status === 'degraded'
            ? ('degraded' as const)
            : status === 'disconnected'
              ? ('disconnected' as const)
              : ('degraded' as const),
      policyVersionId: '0',
      connectedAtIso: new Date().toISOString(),
    };
  }
}
