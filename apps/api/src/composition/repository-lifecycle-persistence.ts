/**
 * C013 — durable PostgreSQL adapter for RepositoryLifecyclePersistencePort.
 */
import { createHash } from 'node:crypto';
import {
  ConnectedRepositoryStore,
  PolicyVersionStore,
  uuidv7,
  type ConnectedRepository,
  type DevGuardPool,
} from '@devguard/db';
import type {
  ConnectedRepositoryRecord,
  RepositoryLifecyclePersistencePort,
  RepositoryLifecycleStatus,
} from '@devguard/github-adapter';

function mapLifecycleStatus(status: ConnectedRepository['status']): RepositoryLifecycleStatus {
  if (status === 'active') return 'connected';
  if (status === 'pending') return 'degraded';
  return status;
}

function mapDbStatus(status: RepositoryLifecycleStatus): ConnectedRepository['status'] {
  if (status === 'connected') return 'active';
  return status;
}

function parseInstallationPermissions(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.entries(parsed)
      .filter(([, value]) => value === 'read' || value === 'write')
      .map(([key, value]) => `${key}: ${value}`);
  } catch {
    return [];
  }
}

function toRecord(
  row: ConnectedRepository,
  policyVersionId: string,
  options: {
    readonly visibility?: 'public' | 'private' | undefined;
    readonly degradedReasonCode?: string | undefined;
    readonly lastSyncedAtIso?: string | undefined;
  } = {},
): ConnectedRepositoryRecord {
  return {
    id: row.id,
    repositoryDevguardId: row.id,
    githubRepositoryId: Number(row.githubRepositoryId),
    installationId: row.installationId,
    ownerLogin: row.owner,
    repoName: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    visibility: options.visibility ?? 'private',
    status: mapLifecycleStatus(row.status),
    policyVersionId,
    connectedAtIso: new Date().toISOString(),
    ...(options.lastSyncedAtIso !== undefined ? { lastSyncedAtIso: options.lastSyncedAtIso } : {}),
    ...(options.degradedReasonCode !== undefined
      ? { degradedReasonCode: options.degradedReasonCode }
      : {}),
  };
}

function conservativePolicyJson(owner: string, name: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    repository: { owner, name },
    autonomy: { level: 'assist' },
    triggers: {},
    manualCommands: [
      'review_remediation',
      'diagnose_failure',
      'security_audit',
      'security_patch',
      'implement_issue',
    ],
    actions: {
      allow: ['repository.read', 'issue.read', 'file.read'],
      requireApproval: ['pull_request.merge', 'workflow_file.write'],
      deny: [],
    },
    validation: { obligations: ['run_tests'] },
    limits: { maxFilesChanged: 25, maxIterations: 6, maxRuntimeMinutes: 20 },
  });
}

export class DurableRepositoryLifecyclePersistence implements RepositoryLifecyclePersistencePort {
  private readonly repos: ConnectedRepositoryStore;
  private readonly policies: PolicyVersionStore;
  private readonly policyVersionByRepo = new Map<string, string>();

  constructor(private readonly pool: DevGuardPool) {
    this.repos = new ConnectedRepositoryStore(pool);
    this.policies = new PolicyVersionStore(pool);
  }

  async findByGithubRepositoryId(
    githubRepositoryId: number,
  ): Promise<ConnectedRepositoryRecord | undefined> {
    const row = await this.repos.findByGitHubId(String(githubRepositoryId));
    if (row === null) return undefined;
    const active = await this.policies.getActive(row.id);
    return toRecord(row, active?.version !== undefined ? String(active.version) : '0');
  }

  async findByInstallationId(installationId: string): Promise<readonly ConnectedRepositoryRecord[]> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT id, github_repository_id, installation_id, owner, name, full_name,
        default_branch, status, row_version::text AS row_version
      FROM repositories WHERE installation_id = $1`,
      values: [installationId],
    });
    const records: ConnectedRepositoryRecord[] = [];
    for (const row of rows) {
      const repo = {
        id: String(row['id']),
        githubRepositoryId: String(row['github_repository_id']),
        installationId: String(row['installation_id']),
        owner: String(row['owner']),
        name: String(row['name']),
        fullName: String(row['full_name']),
        defaultBranch: String(row['default_branch'] ?? 'main'),
        status: String(row['status']) as ConnectedRepository['status'],
        rowVersion: Number(row['row_version'] ?? 0),
      };
      const active = await this.policies.getActive(repo.id);
      records.push(toRecord(repo, active?.version !== undefined ? String(active.version) : '0'));
    }
    return records;
  }

  async insertConnected(): Promise<ConnectedRepositoryRecord> {
    throw new Error('insert_connected_unsupported_use_onboard');
  }

  async onboardRepository(input: {
    githubRepositoryId: number;
    installationId: string;
    ownerLogin: string;
    repoName: string;
    defaultBranch: string;
    visibility: 'public' | 'private';
    seedPolicy: (repositoryDevguardId: string) => Promise<{ policyVersionId: string }>;
  }): Promise<ConnectedRepositoryRecord> {
    const id = uuidv7();
    const inserted = await this.repos.insert({
      id,
      githubRepositoryId: String(input.githubRepositoryId),
      installationId: input.installationId,
      owner: input.ownerLogin,
      name: input.repoName,
      fullName: `${input.ownerLogin}/${input.repoName}`,
    });
    const seeded = await input.seedPolicy(id);
    this.policyVersionByRepo.set(id, seeded.policyVersionId);
    const active = await this.repos.transition(
      id,
      inserted.rowVersion,
      'active',
      { defaultBranch: input.defaultBranch },
    );
    return toRecord(active, seeded.policyVersionId, { visibility: input.visibility });
  }

  async updateStatus(input: {
    repositoryDevguardId: string;
    status: RepositoryLifecycleStatus;
    degradedReasonCode?: string | undefined;
    lastSyncedAtIso?: string | undefined;
  }): Promise<ConnectedRepositoryRecord> {
    const current = await this.repos.findById(input.repositoryDevguardId);
    if (current === null) throw new Error(`NOT_FOUND:${input.repositoryDevguardId}`);
    const next = mapDbStatus(input.status);
    const updated = await this.repos.transition(
      current.id,
      current.rowVersion,
      next,
      {},
    );
    const policyVersionId =
      this.policyVersionByRepo.get(current.id) ??
      String((await this.policies.getActive(current.id))?.version ?? 0);
    return toRecord(updated, policyVersionId, {
      degradedReasonCode: input.degradedReasonCode,
      lastSyncedAtIso: input.lastSyncedAtIso,
    });
  }

  async delete(): Promise<void> {
    throw new Error('delete_not_supported');
  }
}

export class DurableInstallationContextPort {
  constructor(private readonly pool: DevGuardPool) {}

  async verifyInstallation(installationId: string): Promise<{
    active: boolean;
    accountLogin: string;
    permissions: readonly string[];
  }> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT account_login, status, permissions_json::text AS permissions_json
FROM github_installations WHERE id = $1`,
      values: [installationId],
    });
    const row = rows[0];
    if (row === undefined) {
      return { active: false, accountLogin: '', permissions: [] };
    }
    const status = String(row['status']);
    return {
      active: status === 'active',
      accountLogin: String(row['account_login'] ?? ''),
      permissions: parseInstallationPermissions(String(row['permissions_json'] ?? '{}')),
    };
  }
}

export class DurableDefaultPolicySeeder {
  constructor(
    private readonly policies: PolicyVersionStore,
    private readonly createdBy: string,
  ) {}

  async seedDefaultPolicy(input: {
    repositoryDevguardId: string;
    ownerLogin?: string | undefined;
    repoName?: string | undefined;
  }): Promise<{ policyVersionId: string }> {
    const owner = input.ownerLogin ?? 'owner';
    const name = input.repoName ?? 'repo';
    const policyJson = conservativePolicyJson(owner, name);
    const canonicalHash = createHash('sha256').update(policyJson).digest('hex');
    const version = await this.policies.appendVersion({
      repositoryId: input.repositoryDevguardId,
      policyJson,
      canonicalHash,
      createdBy: this.createdBy,
    });
    await this.policies.activateHead(input.repositoryDevguardId, version.id, 0, this.createdBy);
    return { policyVersionId: String(version.version) };
  }
}
