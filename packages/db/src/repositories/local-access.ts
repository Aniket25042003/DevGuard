/**
 * CP005 — durable PostgreSQL implementation of the C006
 * `LocalRepositoryAccessPort`.
 *
 * "Local linkage" is DevGuard's own record of which repositories are wired to
 * which installation (the `repositories` table). Status values are stored as
 * the same literals the authorization port uses, so the mapping is direct. A
 * missing row (undefined) means "unknown locally", which the authorizer treats
 * as REPOSITORY_FORBIDDEN (non-enumerating: missing == forbidden).
 */

export type LocalLinkageStatus = 'pending' | 'active' | 'degraded' | 'disconnected';

export interface LocalRepositoryLinkage {
  readonly status: LocalLinkageStatus;
  readonly installationRef: string;
  /** Repo-specific identity so the GitHub role lookup is repository-scoped. */
  readonly repositoryExternalIdHint?: string | undefined;
}

export class PostgresLocalRepositoryAccessPort {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async findLinkage(repositoryId: string): Promise<LocalRepositoryLinkage | undefined> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: 'SELECT status, installation_id, github_repository_id FROM repositories WHERE id = $1',
      values: [repositoryId],
    });
    const row = rows[0];
    if (row === undefined || row === null) return undefined;
    const status = row['status'] as LocalLinkageStatus;
    if (
      status === undefined ||
      !['pending', 'active', 'degraded', 'disconnected'].includes(status)
    ) {
      // A row with an unknown lifecycle status is treated as disconnected —
      // deny rather than guess. Defensive: the DB CHECK constrains values.
      return { status: 'disconnected', installationRef: String(row['installation_id'] ?? '') };
    }
    return {
      status,
      installationRef: String(row['installation_id'] ?? ''),
      ...(row['github_repository_id'] !== null && row['github_repository_id'] !== undefined
        ? { repositoryExternalIdHint: String(row['github_repository_id']) }
        : {}),
    };
  }

  async isConnectingOwner(repositoryId: string, userId: string): Promise<boolean> {
    const rows = await this.poolLike.query<{ present: boolean }>({
      text: 'SELECT EXISTS (SELECT 1 FROM repositories WHERE id = $1 AND connected_by = $2) AS present',
      values: [repositoryId, userId],
    });
    return rows[0]?.present === true;
  }
}
