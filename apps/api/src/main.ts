/**
 * DevGuard API bootstrap (C005).
 *
 * Startup contract: configuration validated → composition bound → readiness
 * validated → transport assembled. The HTTP listener starts only when
 * RUN_SERVER=1 so CI and tests drive `assembleApi` in-process.
 */
import { loadConfig, safeSummary } from '@devguard/config';
import { toErrorEnvelope } from '@devguard/errors';
import { buildContainer, validateReadiness } from './composition/container.js';
import { assembleApi } from './app.js';

const bootstrap = async (): Promise<void> => {
  const config = await Promise.resolve(loadConfig('api'));
  const container = buildContainer(config);

  if (container.pool !== undefined && globalThis.process?.env?.['RUN_SERVER'] === '1') {
    const { runMigrations } = await import('@devguard/db');
    const migrationResult = await runMigrations(container.pool);
    console.info(
      JSON.stringify({
        msg: 'migrations.applied',
        applied: migrationResult.applied,
        verified: migrationResult.verified,
      }),
    );
  }

  // Fail closed: volatile bindings are refused in production and in development
  // unless the operator explicitly opts in (DEVGUARD_ALLOW_VOLATILE_AUTH=true).
  validateReadiness(config, container.bindings, {
    allowVolatileDevelopment: globalThis.process?.env?.['DEVGUARD_ALLOW_VOLATILE_AUTH'] === 'true',
  });
  const api = assembleApi(container);
  console.info(
    JSON.stringify({
      msg: 'configuration.validated',
      ...safeSummary(config),
      routeCount: api.routeMetadata.size,
    }),
  );

  if (globalThis.process?.env?.['RUN_SERVER'] === '1') {
    const { serve } = await import('@hono/node-server');
    const port = Number.parseInt(globalThis.process?.env?.['PORT'] ?? '4000', 10);
    const server = serve({ fetch: api.app.fetch, port, hostname: '0.0.0.0' });
    console.info(JSON.stringify({ msg: 'http.listening', port }));
    const shutdown = async (): Promise<void> => {
      server.close(() => {
        void container.pool?.drain().finally(() => globalThis.process?.exit(0));
      });
    };
    globalThis.process?.once('SIGTERM', () => void shutdown());
    globalThis.process?.once('SIGINT', () => void shutdown());
  }
};

bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'startup.failed', ...toErrorEnvelope(error, 'startup') }));
  process.exitCode = 1;
});
