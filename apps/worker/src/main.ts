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
  checkWorkerReadiness,
  validateWorkerReadiness,
  workerStartupStatus,
} from './composition/container.js';
import { startWorkerHealthServer } from './health-server.js';
import { OutboxRepository } from '@devguard/db';
import { BullMqQueue, BullMqWorkerRuntime } from '@devguard/queue';
import { publishOutboxOnce } from './composition/outbox-publish.js';
import { assertSchemaCompatible } from '@devguard/db';

const bootstrap = async (): Promise<void> => {
  const config = await Promise.resolve(loadConfig('worker'));
  const container = buildWorkerContainer(config);
  if (container.pool !== undefined) await assertSchemaCompatible(container.pool);
  validateWorkerReadiness(config, container);
  const dependencyReadiness = await checkWorkerReadiness(container);
  if (!dependencyReadiness.ok && config.environment === 'production') {
    throw new Error(`WORKER_DEPENDENCY_UNAVAILABLE:${dependencyReadiness.reasons.join(',')}`);
  }
  const startup = workerStartupStatus(container);

  const portRaw = globalThis.process?.env?.['PORT'];
  let workerReady = false;
  let readinessCheckedAt = 0;
  let readinessInFlight: Promise<boolean> | undefined;
  const refreshReadiness = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - readinessCheckedAt < 5_000) return workerReady;
    if (readinessInFlight !== undefined) return readinessInFlight;
    readinessInFlight = checkWorkerReadiness(container)
      .then((result) => {
        workerReady = result.ok;
        readinessCheckedAt = Date.now();
        return workerReady;
      })
      .catch(() => {
        workerReady = false;
        readinessCheckedAt = Date.now();
        return false;
      })
      .finally(() => {
        readinessInFlight = undefined;
      });
    return readinessInFlight;
  };
  const stopHealth =
    portRaw !== undefined && portRaw.length > 0
      ? startWorkerHealthServer(Number.parseInt(portRaw, 10), refreshReadiness)
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
      void container.redisHealth?.quit();
      process.exit(0);
    };
    process.on('SIGTERM', shutdownIdle);
    process.on('SIGINT', shutdownIdle);
  } else {
    // CP008: start the typed queue consumers from the durable WorkerRuntime.
    const runtime = container.runtime;
    runtime.start();
    workerReady = dependencyReadiness.ok;
    if (!dependencyReadiness.ok) {
      console.warn(
        JSON.stringify({ msg: 'worker.dependency_degraded', reasons: dependencyReadiness.reasons }),
      );
    }
    const outboxRelay =
      container.pool !== undefined && container.queue instanceof BullMqQueue
        ? setInterval(() => {
            void publishOutboxOnce({
              outbox: new OutboxRepository(container.pool!),
              queue: container.queue,
              workerId: `relay-${process.pid}`,
            }).catch((error: unknown) => {
              console.error(
                JSON.stringify({ msg: 'outbox.relay_failed', ...toErrorEnvelope(error, 'outbox') }),
              );
            });
          }, 500)
        : undefined;
    const interval =
      runtime instanceof BullMqWorkerRuntime
        ? undefined
        : setInterval(async () => {
            try {
              await runtime.processOnce(Date.now());
            } catch (error) {
              console.error(
                JSON.stringify({ msg: 'worker.poll_failed', ...toErrorEnvelope(error, 'poll') }),
              );
            }
          }, container.runtime.pollIntervalMs);
    const shutdown = (): void => {
      workerReady = false;
      if (interval !== undefined) clearInterval(interval);
      if (outboxRelay !== undefined) clearInterval(outboxRelay);
      runtime.stop();
      stopHealth?.();
      void runtime
        .drain(() => false)
        .then(() => (container.queue instanceof BullMqQueue ? container.queue.close() : undefined))
        .finally(() => container.redisHealth?.quit())
        .finally(() => process.exit(0));
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
