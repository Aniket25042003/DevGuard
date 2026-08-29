/**
 * Fetch a GitHub App installation snapshot using an app JWT.
 */
import type { GitHubTransport } from '../core/client.js';
import type { AppJwtSigner, SecretKeyProvider } from './app-jwt-signer.js';

const API_VERSION = '2022-11-28';

export interface FetchedInstallationSnapshot {
  readonly githubInstallationId: string;
  readonly accountType: 'User' | 'Organization';
  readonly accountId: number;
  readonly accountLogin: string;
  readonly status: 'active' | 'suspended' | 'deleted';
  readonly permissionsJson: string;
  readonly repositorySelection: string;
  readonly suspendedAt?: string | undefined;
}

export interface FetchAppInstallationOptions {
  readonly transport: GitHubTransport;
  readonly signer: AppJwtSigner;
  readonly keyProvider: SecretKeyProvider;
  readonly installationId: string;
  readonly apiVersion?: string | undefined;
}

export async function fetchAppInstallation(
  options: FetchAppInstallationOptions,
): Promise<FetchedInstallationSnapshot> {
  const key = await options.keyProvider.load();
  const signed = options.signer.sign(key);
  const response = await options.transport.request({
    method: 'GET',
    path: `/app/installations/${encodeURIComponent(options.installationId)}`,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${signed.jwt.expose()}`,
      'x-github-api-version': options.apiVersion ?? API_VERSION,
    },
    timeoutMs: 30_000,
    host: 'api.github.com',
  });
  if (response.status !== 200) {
    throw new Error(`github_installation_fetch_failed:${response.status}`);
  }
  const body = JSON.parse(response.bodyText ?? '{}') as Record<string, unknown>;
  const account =
    body['account'] !== null && typeof body['account'] === 'object'
      ? (body['account'] as Record<string, unknown>)
      : undefined;
  const accountId = account?.['id'];
  const accountLogin = account?.['login'];
  const accountType = account?.['type'];
  const installationId = body['id'];
  if (
    typeof installationId !== 'number' ||
    typeof accountId !== 'number' ||
    typeof accountLogin !== 'string' ||
    (accountType !== 'User' && accountType !== 'Organization')
  ) {
    throw new Error('github_installation_shape_invalid');
  }
  const permissions = body['permissions'];
  const repositorySelection = body['repository_selection'];
  const suspendedAt = body['suspended_at'];
  return {
    githubInstallationId: String(installationId),
    accountType,
    accountId,
    accountLogin,
    status: suspendedAt === null || suspendedAt === undefined ? 'active' : 'suspended',
    permissionsJson: JSON.stringify(permissions ?? {}),
    repositorySelection:
      typeof repositorySelection === 'string' ? repositorySelection : 'selected',
    ...(typeof suspendedAt === 'string' ? { suspendedAt } : {}),
  };
}
