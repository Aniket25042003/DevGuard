/**
 * C013/C014 — API composition for repository lifecycle + metadata/health services.
 */
import type { DevGuardPool } from '@devguard/db';
import { ConnectedRepositoryStore, PolicyVersionStore } from '@devguard/db';
import {
  InMemoryMetadataSnapshotStore,
  RepositoryLifecycleService,
  RepositoryMetadataHealthService,
} from '@devguard/github-adapter';
import type { RepositoryMetadataHealthService as MetadataHealthServiceType } from '@devguard/github-adapter';
import {
  DurableDefaultPolicySeeder,
  DurableInstallationContextPort,
  DurableRepositoryLifecyclePersistence,
} from './repository-lifecycle-persistence.js';
import {
  DurableLifecycleReadPort,
  LifecycleLinkedMetadataProvider,
} from './repository-metadata-health.js';

export interface RepositoryDomainServices {
  readonly lifecycle: RepositoryLifecycleService;
  readonly metadataHealth: MetadataHealthServiceType;
}

export function buildRepositoryDomainServices(
  pool: DevGuardPool,
  createdBy: string,
): RepositoryDomainServices {
  const persistence = new DurableRepositoryLifecyclePersistence(pool);
  const policySeeder = new DurableDefaultPolicySeeder(new PolicyVersionStore(pool), createdBy);
  const repos = new ConnectedRepositoryStore(pool);
  const lifecycleRead = new DurableLifecycleReadPort(pool);
  const lifecycle = new RepositoryLifecycleService(
    persistence,
    {
      seedDefaultPolicy: async (input) => {
        const row = await repos.findById(input.repositoryDevguardId);
        return policySeeder.seedDefaultPolicy({
          repositoryDevguardId: input.repositoryDevguardId,
          ownerLogin: row?.owner,
          repoName: row?.name,
        });
      },
    },
    new DurableInstallationContextPort(pool),
  );
  const metadataHealth = new RepositoryMetadataHealthService({
    store: new InMemoryMetadataSnapshotStore(),
    provider: new LifecycleLinkedMetadataProvider(lifecycleRead),
    lifecycle: lifecycleRead,
  });
  return { lifecycle, metadataHealth };
}
