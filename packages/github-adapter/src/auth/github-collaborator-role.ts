/**
 * C017 — fetch a user's normalized repository role via GitHub collaborator API.
 */
import { createHash } from 'node:crypto';
import type { GitHubTransport } from '../core/client.js';
import type { SecretString } from './contracts.js';

export type NormalizedGitHubRole = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

const API_VERSION = '2022-11-28';

function normalizePermission(raw: string): NormalizedGitHubRole {
  switch (raw) {
    case 'admin':
    case 'maintain':
    case 'write':
    case 'triage':
    case 'read':
      return raw;
    default:
      return 'none';
  }
}

export class GitHubCollaboratorRoleService {
  constructor(
    private readonly transport: GitHubTransport,
    private readonly apiVersion = API_VERSION,
  ) {}

  async fetchRole(input: {
    readonly token: SecretString;
    readonly owner: string;
    readonly repo: string;
    readonly userLogin: string;
  }): Promise<{ role: NormalizedGitHubRole; snapshotHash: string }> {
    const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/collaborators/${encodeURIComponent(input.userLogin)}/permission`;
    const response = await this.transport.request({
      method: 'GET',
      path,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.token.expose()}`,
        'x-github-api-version': this.apiVersion,
      },
      timeoutMs: 30_000,
      host: 'api.github.com',
    });
    if (response.status === 404) {
      const snapshotHash = createHash('sha256')
        .update(JSON.stringify({ permission: 'none', owner: input.owner, repo: input.repo }))
        .digest('hex');
      return { role: 'none', snapshotHash };
    }
    if (response.status !== 200) {
      throw new Error(`github_collaborator_permission_failed:${response.status}`);
    }
    const parsed = JSON.parse(response.bodyText ?? '{}') as { permission?: string };
    const permission = typeof parsed.permission === 'string' ? parsed.permission : 'none';
    const role = normalizePermission(permission);
    const snapshotHash = createHash('sha256')
      .update(
        JSON.stringify({
          permission,
          owner: input.owner,
          repo: input.repo,
          login: input.userLogin,
        }),
      )
      .digest('hex');
    return { role, snapshotHash };
  }
}
