/**
 * C009 — Identity and repository aggregate persistence.
 *
 * SQL terminates here. Domain services see typed results; provider/SQL row
 * shapes never cross this boundary.
 */
import type { TransactionContext } from '../transaction.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserIdentity {
  readonly userId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly loginSnapshot: string;
}

export interface ObservedIdentityInput {
  readonly userId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly loginSnapshot: string;
}

export interface InstallationSnapshot {
  /** String to avoid precision loss on large GitHub IDs. */
  readonly githubInstallationId: string;
  readonly accountType: 'User' | 'Organization';
  readonly accountId: number;
  readonly accountLogin: string;
  readonly status: 'active' | 'suspended' | 'deleted';
  readonly permissionsJson: string;
  readonly repositorySelection: string;
  readonly suspendedAt?: string | undefined;
}

export interface ConnectedRepository {
  readonly id: string;
  /** String to avoid precision loss on large GitHub IDs. */
  readonly githubRepositoryId: string;
  readonly installationId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly status: 'pending' | 'active' | 'degraded' | 'disconnected';
  readonly rowVersion: number;
}

export interface ConnectRepositoryInput {
  readonly id: string;
  readonly githubRepositoryId: string;
  readonly installationId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly connectedBy?: string | undefined;
}

export type RepositoryLifecycleStatus = 'pending' | 'active' | 'degraded' | 'disconnected';

export interface RepositoryPatch {
  readonly defaultBranch?: string | undefined;
  readonly autonomyLevel?: string | undefined;
}

const REPO_COLS = `id, github_repository_id, installation_id, owner, name, full_name,
  default_branch, status, row_version::text AS row_version`;

function mapRepository(row: Record<string, unknown>): ConnectedRepository {
  return {
    id: String(row['id']),
    githubRepositoryId: String(row['github_repository_id']),
    installationId: String(row['installation_id']),
    owner: String(row['owner']),
    name: String(row['name']),
    fullName: String(row['full_name']),
    defaultBranch: String(row['default_branch'] ?? 'main'),
    status: (row['status'] as ConnectedRepository['status']) ?? 'pending',
    rowVersion: Number(row['row_version'] ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export class IdentityRepository {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async findByExternalSubject(issuer: string, subject: string): Promise<UserIdentity | null> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: 'SELECT user_id, issuer, subject, login_snapshot FROM external_identities WHERE issuer = $1 AND subject = $2',
      values: [issuer, subject],
    });
    const row = rows[0];
    if (!row) return null;
    return {
      userId: String(row['user_id']),
      issuer: String(row['issuer']),
      subject: String(row['subject']),
      loginSnapshot: String(row['login_snapshot']),
    };
  }

  async upsertObservedIdentity(
    input: ObservedIdentityInput,
    tx?: TransactionContext,
  ): Promise<void> {
    const sql = `
INSERT INTO external_identities (id, user_id, issuer, subject, login_snapshot)
VALUES (gen_random_uuid(), $1, $2, $3, $4)
ON CONFLICT (issuer, subject) DO UPDATE SET last_seen_at = now(), login_snapshot = EXCLUDED.login_snapshot`;
    const executor = tx ?? { query: this.poolLike.query.bind(this.poolLike) };
    await executor.query({
      text: sql,
      values: [input.userId, input.issuer, input.subject, input.loginSnapshot],
    });
  }
}

export class InstallationStore {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async upsertSnapshot(input: InstallationSnapshot, tx?: TransactionContext): Promise<void> {
    const sql = `
INSERT INTO github_installations
  (id, github_installation_id, account_type, account_id, account_login, status, permissions_json, repository_selection, suspended_at)
VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8)
ON CONFLICT (github_installation_id) DO UPDATE SET
  account_login = EXCLUDED.account_login,
  status = EXCLUDED.status,
  permissions_json = EXCLUDED.permissions_json,
  repository_selection = EXCLUDED.repository_selection,
  suspended_at = EXCLUDED.suspended_at,
  updated_at = now()`;
    const executor = tx ?? { query: this.poolLike.query.bind(this.poolLike) };
    await executor.query({
      text: sql,
      values: [
        input.githubInstallationId,
        input.accountType,
        input.accountId,
        input.accountLogin,
        input.status,
        input.permissionsJson,
        input.repositorySelection,
        input.suspendedAt ?? null,
      ],
    });
  }

  async listForUser(
    userId: string,
  ): Promise<readonly (InstallationSnapshot & { readonly id: string })[]> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT gi.id::text AS id, github_installation_id, account_type, account_id, account_login, status,
        permissions_json::text AS permissions_json, repository_selection, suspended_at::text AS suspended_at
FROM github_installations gi
JOIN user_installation_links uil ON uil.installation_id = gi.id
WHERE uil.user_id = $1
ORDER BY account_login`,
      values: [userId],
    });
    return rows.map((row) => ({
      id: String(row['id']),
      githubInstallationId: String(row['github_installation_id']),
      accountType: row['account_type'] === 'Organization' ? 'Organization' : 'User',
      accountId: Number(row['account_id']),
      accountLogin: String(row['account_login']),
      status: (row['status'] as InstallationSnapshot['status']) ?? 'active',
      permissionsJson: String(row['permissions_json'] ?? '{}'),
      repositorySelection: String(row['repository_selection'] ?? 'selected'),
      ...(row['suspended_at'] ? { suspendedAt: String(row['suspended_at']) } : {}),
    }));
  }

  async findInternalId(installationRef: string): Promise<string | null> {
    const rows = await this.poolLike.query<{ id: string }>({
      text: 'SELECT id::text AS id FROM github_installations WHERE id::text = $1 OR github_installation_id::text = $1',
      values: [installationRef],
    });
    return rows[0]?.id ?? null;
  }

  async linkUser(userId: string, installationId: string, tx?: TransactionContext): Promise<void> {
    const sql = `
INSERT INTO user_installation_links (user_id, installation_id, role, verified_at)
VALUES ($1, $2, 'admin', now())
ON CONFLICT (user_id, installation_id) DO UPDATE SET verified_at = now()`;
    const executor = tx ?? { query: this.poolLike.query.bind(this.poolLike) };
    await executor.query({ text: sql, values: [userId, installationId] });
  }
}

export class ConnectedRepositoryStore {
  constructor(
    private readonly poolLike: {
      query<T>(config: { text: string; values?: unknown[] }): Promise<T[]>;
    },
  ) {}

  async insert(
    input: ConnectRepositoryInput,
    tx?: TransactionContext,
  ): Promise<ConnectedRepository> {
    const sql = `
INSERT INTO repositories (id, github_repository_id, installation_id, owner, name, full_name, status, connected_by, connected_at)
VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, now())
RETURNING ${REPO_COLS}`;
    const executor = tx ?? { query: this.poolLike.query.bind(this.poolLike) };
    const rows = await executor.query<Record<string, unknown>>({
      text: sql,
      values: [
        input.id,
        input.githubRepositoryId,
        input.installationId,
        input.owner,
        input.name,
        input.fullName,
        input.connectedBy ?? null,
      ],
    });
    const row = rows[0];
    if (!row) throw new Error('insert returned no rows');
    return mapRepository(row);
  }

  async findById(id: string): Promise<ConnectedRepository | null> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT ${REPO_COLS} FROM repositories WHERE id = $1`,
      values: [id],
    });
    const row = rows[0];
    return row ? mapRepository(row) : null;
  }

  async listForUser(userId: string): Promise<readonly ConnectedRepository[]> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT ${REPO_COLS} FROM repositories WHERE connected_by = $1 AND status != 'disconnected' ORDER BY full_name`,
      values: [userId],
    });
    return rows.map(mapRepository);
  }

  async findByGitHubId(githubId: string): Promise<ConnectedRepository | null> {
    const rows = await this.poolLike.query<Record<string, unknown>>({
      text: `SELECT ${REPO_COLS} FROM repositories WHERE github_repository_id = $1`,
      values: [githubId],
    });
    const row = rows[0];
    return row ? mapRepository(row) : null;
  }

  /** CAS lifecycle transition with legal-guard enforcement at the DB level. */
  private static readonly LEGAL: Readonly<Record<string, readonly string[]>> = Object.freeze({
    pending: ['active', 'degraded', 'disconnected'],
    active: ['degraded', 'disconnected'],
    degraded: ['active', 'disconnected'],
    disconnected: ['pending'],
  });

  async transition(
    id: string,
    expectedVersion: number,
    next: RepositoryLifecycleStatus,
    patch: RepositoryPatch,
    tx?: TransactionContext,
  ): Promise<ConnectedRepository> {
    // Fetch current state for lifecycle guard.
    const current = await this.findById(id);
    if (current === undefined || current === null) {
      throw new Error(`NOT_FOUND:${id}`);
    }
    const allowed = ConnectedRepositoryStore.LEGAL[current.status] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(`ILLEGAL_TRANSITION:${current.status}->${next}`);
    }

    const autonomyLevel =
      'autonomyLevel' in patch && typeof patch.autonomyLevel === 'string'
        ? patch.autonomyLevel
        : null;
    const executor = tx ?? { query: this.poolLike.query.bind(this.poolLike) };
    const rows = await executor.query<Record<string, unknown>>({
      text: `
UPDATE repositories SET
  status = $2,
  default_branch = COALESCE($3, default_branch),
  autonomy_level = COALESCE($5, autonomy_level),
  disconnected_at = CASE WHEN $2 = 'disconnected' THEN now() ELSE disconnected_at END,
  updated_at = now(),
  row_version = row_version + 1
WHERE id = $1 AND row_version = $4 AND status != $2
RETURNING ${REPO_COLS}, autonomy_level`,
      values: [id, next, patch.defaultBranch ?? null, expectedVersion, autonomyLevel],
    });
    const row = rows[0];
    if (!row) throw new Error(`VERSION_CONFLICT:expected=${expectedVersion}`);
    return mapRepository(row);
  }
}
