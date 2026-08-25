#!/usr/bin/env node
/**
 * DevGuard worker bootstrap.
 *
 * Startup contract (C002): configuration is validated before the worker
 * consumes any queue. Job infrastructure arrives with C057.
 */
import { loadConfig, safeSummary } from '@devguard/config';
import { toErrorEnvelope } from '@devguard/errors';

const bootstrap = async (): Promise<void> => {
  const config = await Promise.resolve(loadConfig('worker'));
  console.info(JSON.stringify({ msg: 'configuration.validated', ...safeSummary(config) }));
  // TODO(C057): start typed queue consumers here.
};

bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'startup.failed', ...toErrorEnvelope(error, 'startup') }));
  process.exitCode = 1;
});
