/**
 * C017/C006 — resolve GitHub permission lookup context from durable linkage.
 */
export interface GitHubPermissionLookupContext {
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly repo: string;
  readonly userLogin: string;
  readonly githubRepositoryId: string;
}

export class PostgresGitHubPermissionLookup {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async resolve(input: {
    readonly installationRef: string;
    readonly repositoryExternalIdHint?: string | undefined;
    readonly providerSubject: string;
    readonly issuer?: string | undefined;
  }): Promise<GitHubPermissionLookupContext | undefined> {
    const issuer = input.issuer ?? 'https://github.com';
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `
SELECT gi.github_installation_id::text AS github_installation_id,
       r.owner,
       r.name AS repo,
       r.github_repository_id::text AS github_repository_id,
       ei.login_snapshot AS user_login
FROM external_identities ei
JOIN github_installations gi ON gi.id = $1
JOIN repositories r ON r.installation_id = gi.id
WHERE ei.issuer = $2
  AND ei.subject = $3
  AND ($4::bigint IS NULL OR r.github_repository_id = $4::bigint)
ORDER BY r.github_repository_id
LIMIT 1`,
      values: [
        input.installationRef,
        issuer,
        input.providerSubject,
        input.repositoryExternalIdHint ?? null,
      ],
    });
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      githubInstallationId: String(row['github_installation_id']),
      owner: String(row['owner']),
      repo: String(row['repo']),
      userLogin: String(row['user_login']),
      githubRepositoryId: String(row['github_repository_id']),
    };
  }
}
