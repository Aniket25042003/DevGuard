#!/usr/bin/env node
/**
 * DevGuard worker bootstrap.
 *
 * Startup contract (C002/CP002): configuration is validated before the worker
 * consumes any queue, and bindings are validated for durability. Until CP008
 * wires a durable Redis QueueTransport, the worker reports
 * 'worker.transport_unavailable' and idles instead of pretending to consume.
 * In production a volatile (in-memory) queue is refused by
 * `validateWorkerReadiness`, so the process exits nonzero (fail closed).
 */
import { loadConfig, safeSummary } from '@devguard/config';
import { toErrorEnvelope } from '@devguard/errors';
import {
  buildWorkerContainer,
  validateWorkerReadiness,
  workerStartupStatus,
} from './composition/container.js';
import { startWorkerHealthServer } from './health-server.js';

const bootstrap = async (): Promise<void> => {
  const config = await Promise.resolve(loadConfig('worker'));
  const container = buildWorkerContainer(config);
  validateWorkerReadiness(config, container);
  const startup = workerStartupStatus(container);

  const portRaw = globalThis.process?.env?.['PORT'];
  const stopHealth =
    portRaw !== undefined && portRaw.length > 0
      ? startWorkerHealthServer(Number.parseInt(portRaw, 10))
      : undefined;

  console.info(
    JSON.stringify({
      msg: 'configuration.validated',
      ...safeSummary(config),
      workerStartup: startup,
    }),
  );
  if (startup === 'idle_no_transport') {
    console.info(
      JSON.stringify({
        msg: 'worker.transport_unavailable',
        detail: 'durable QueueTransport wired in CP008; worker idles until then',
      }),
    );
    const shutdownIdle = (): void => {
      stopHealth?.();
      process.exit(0);
    };
    process.on('SIGTERM', shutdownIdle);
    process.on('SIGINT', shutdownIdle);
  } else {
    // CP008: start the typed queue consumers from the durable WorkerRuntime.
    const runtime = container.runtime;
    runtime.start();
    const interval = setInterval(async () => {
      try {
        await runtime.processOnce(Date.now());
      } catch (error) {
        console.error(
          JSON.stringify({ msg: 'worker.poll_failed', ...toErrorEnvelope(error, 'poll') }),
        );
      }
    }, container.runtime.pollIntervalMs);
    const shutdown = (): void => {
      clearInterval(interval);
      runtime.stop();
      stopHealth?.();
      void runtime.drain(() => false).finally(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    console.info(JSON.stringify({ msg: 'worker.consuming' }));
  }
};

bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'startup.failed', ...toErrorEnvelope(error, 'startup') }));
  process.exitCode = 1;
});
