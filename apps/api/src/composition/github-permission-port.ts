/**
 * C017/C006 — wire durable GitHub permission evidence when app credentials exist.
 */
import type { GitHubPermissionPort } from '@devguard/authorization';
import type { GithubAppConfig } from '@devguard/config';
import type { DevGuardPool } from '@devguard/db';
import { PostgresGitHubPermissionLookup } from '@devguard/db';
import {
  AppJwtSigner,
  FetchInstallationTokenMintPort,
  FetchTransport,
  GitHubPermissionService,
  InMemoryKeyProvider,
  asGitHubPermissionPort,
} from '@devguard/github-adapter';

export function buildGitHubPermissionPort(
  pool: DevGuardPool | undefined,
  github: GithubAppConfig | undefined,
  privateKeyPem: string | undefined,
): GitHubPermissionPort {
  if (pool === undefined || github === undefined || privateKeyPem === undefined) {
    return new UnavailableGitHubPermissionPort();
  }
  const transport = new FetchTransport();
  const signer = new AppJwtSigner({ nowMs: () => Date.now() });
  const keyProvider = new InMemoryKeyProvider({
    appId: github.appId,
    privateKeyPem,
    keyVersion: 'v1',
  });
  const mint = new FetchInstallationTokenMintPort({ transport, signer, keyProvider });
  const lookup = new PostgresGitHubPermissionLookup(pool);
  const service = new GitHubPermissionService({
    context: {
      resolve: (input) => lookup.resolve(input),
    },
    mint,
    transport,
    credentialVersion: github.appId,
  });
  return asGitHubPermissionPort(service) as GitHubPermissionPort;
}

class UnavailableGitHubPermissionPort implements GitHubPermissionPort {
  async fetchUserRole(): Promise<{ role: 'none'; snapshotHash: string }> {
    throw new Error('github_permission_port_unavailable');
  }
}
