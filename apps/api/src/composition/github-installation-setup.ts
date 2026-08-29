/**
 * Completes GitHub App installation setup: fetch from GitHub, persist, link user.
 */
import type { GithubAppConfig } from '@devguard/config';
import type { DevGuardPool } from '@devguard/db';
import { InstallationStore } from '@devguard/db';
import {
  AppJwtSigner,
  FetchTransport,
  fetchAppInstallation,
  InMemoryKeyProvider,
  normalizePrivateKeyPem,
} from '@devguard/github-adapter';

export async function completeGitHubInstallationSetup(input: {
  readonly pool: DevGuardPool;
  readonly github: GithubAppConfig;
  readonly privateKeyPem: string;
  readonly userId: string;
  readonly githubInstallationId: string;
}): Promise<{ readonly installationId: string; readonly accountLogin: string }> {
  const transport = new FetchTransport();
  const signer = new AppJwtSigner({ nowMs: () => Date.now() });
  const keyProvider = new InMemoryKeyProvider({
    appId: input.github.appId,
    privateKeyPem: normalizePrivateKeyPem(input.privateKeyPem),
    keyVersion: 'v1',
  });
  const snapshot = await fetchAppInstallation({
    transport,
    signer,
    keyProvider,
    installationId: input.githubInstallationId,
  });
  const store = new InstallationStore(input.pool);
  await store.upsertSnapshot(snapshot);
  const internalId = await store.findInternalId(snapshot.githubInstallationId);
  if (internalId === null) {
    throw new Error('installation_persist_failed');
  }
  await store.linkUser(input.userId, internalId);
  return { installationId: internalId, accountLogin: snapshot.accountLogin };
}
