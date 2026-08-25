#!/usr/bin/env node
/**
 * DevGuard API bootstrap.
 *
 * Startup contract (C002): configuration is validated before the process can
 * become ready. The real HTTP server arrives with C005; until then this entry
 * proves the composition path (load → validate → safe summary).
 */
import { EnvironmentSecretProvider, loadConfig, safeSummary } from '@devguard/config';
import { toErrorEnvelope } from '@devguard/errors';

const bootstrap = async (): Promise<void> => {
  // Fail fast before binding anything: invalid configuration never serves.
  const config = await Promise.resolve(loadConfig('api'));
  const secrets = new EnvironmentSecretProvider();

  // Prove the resolution port works without exposing values (C093 hardens this).
  await secrets.get({ name: 'DEVGUARD_ENV' }).catch(() => undefined);

  // Safe summary only: presence/health metadata, never secret values.
  console.info(JSON.stringify({ msg: 'configuration.validated', ...safeSummary(config) }));
  // TODO(C005): bind the versioned /api/v1 transport here.
};

bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'startup.failed', ...toErrorEnvelope(error, 'startup') }));
  process.exitCode = 1;
});
