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
  validateReadiness(config, container.bindings);
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
    const server = serve({ fetch: api.app.fetch, port });
    console.info(JSON.stringify({ msg: 'http.listening', port }));
    const shutdown = (): void => {
      server.close(() => globalThis.process?.exit(0));
    };
    globalThis.process?.once('SIGTERM', shutdown);
    globalThis.process?.once('SIGINT', shutdown);
  }
};

bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'startup.failed', ...toErrorEnvelope(error, 'startup') }));
  process.exitCode = 1;
});
