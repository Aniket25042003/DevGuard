/**
 * C012 — worker handler: tombstone artifacts past the conservative default TTL.
 */
import type { JobHandler, JobRegistry } from '@devguard/queue';

export interface ArtifactRetentionCleaner {
  expireEligible(batchSize: number): Promise<number>;
}

export interface RetentionCleanupDeps {
  readonly cleaner: ArtifactRetentionCleaner;
  readonly batchSize?: number | undefined;
}

export function registerRetentionCleanup(registry: JobRegistry, deps: RetentionCleanupDeps): void {
  const batchSize = deps.batchSize ?? 100;
  const handler: JobHandler = async () => {
    const expired = await deps.cleaner.expireEligible(batchSize);
    return { outcome: 'SUCCEEDED', detail: `expired_${expired}` };
  };
  registry.register('cleanup.retention', 1, handler);
}
