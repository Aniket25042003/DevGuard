/**
 * CP008 — Worker composition root (durable queue + typed consumers).
 *
 * Workers act ONLY as scoped system actors bound to persisted runs/approvals.
 * No user principals exist here; forged user actors cannot be constructed.
 *
 * CP008 wires the durable Redis `QueueTransport` (ioredis) when REDIS_URL is
 * configured, registers the typed job handlers (workflow.execute transitions
 * a claimed run queued → running; the other owners fail CLOSED until they
 * mount), and builds the `WorkerRuntime` poll loop. In production a volatile
 * (in-memory) queue is refused, so the worker never silently runs on a
 * non-durable queue.
 */
import { Redis } from 'ioredis';
import {
  RepositoryAuthorizationService,
  type AuthorizationEvidencePort,
  type GitHubPermissionPort,
  type LocalRepositoryAccessPort,
} from '@devguard/authorization';
import type { WorkerConfigSnapshot } from '@devguard/config';
import { configurationInvalid } from '@devguard/errors';
import {
  CancellationFence,
  InMemoryDeliveryStore,
  InMemoryTransport,
  JobRegistry,
  QUEUE_NAMES,
  RedisQueueTransport,
  WorkerRuntime,
  type QueueTransport,
} from '@devguard/queue';
import { createPool, PostgresWebhookDeliveryStore, type DevGuardPool } from '@devguard/db';
import {
  durableRunTransitions,
  registerApprovalResume,
  registerFailClosedHandlers,
  registerWebhookProcess,
  registerWorkflowExecute,
  volatileRunTransitions,
} from './handlers.js';
import { buildCommentCommandService, buildWorkerAuthorizer } from './comment-commands.js';
import { EmptyLocalRepositoryAccessPort, UnavailableGitHubPermissionPort } from './stubs.js';

export interface WorkerContainer {
  readonly config: WorkerConfigSnapshot;
  readonly authorizer: RepositoryAuthorizationService;
  /** Durable Redis queue substrate; InMemoryTransport is volatile and refused in production. */
  readonly queue: QueueTransport;
  readonly registry: JobRegistry;
  readonly runtime: WorkerRuntime;
  readonly transportDurability: 'redis' | 'in_memory';
  readonly pool?: DevGuardPool | undefined;
}

function real(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && !value.startsWith('<');
}

export function buildWorkerContainer(config: WorkerConfigSnapshot): WorkerContainer {
  const localAccess: LocalRepositoryAccessPort = new EmptyLocalRepositoryAccessPort();
  const githubPermissions: GitHubPermissionPort = new UnavailableGitHubPermissionPort();
  const evidence: AuthorizationEvidencePort = new (class implements AuthorizationEvidencePort {
    private readonly rows: Parameters<AuthorizationEvidencePort['append']>[0][] = [];
    async append(record: Parameters<AuthorizationEvidencePort['append']>[0]): Promise<void> {
      this.rows.push(record);
    }
    async findFresh(): Promise<undefined> {
      // System-actor capabilities are always fresh-checked; no cache reads.
      return undefined;
    }
  })();

  const authorizer = new RepositoryAuthorizationService({
    local: localAccess,
    github: githubPermissions,
    evidence,
    readCacheTtlSeconds: 0,
    now: () => new Date(),
  });

  const redisUrl = real(config.redisUrlRef.name) ? config.redisUrlRef.name : undefined;
  const transportDurability = redisUrl !== undefined ? 'redis' : 'in_memory';
  const queue: QueueTransport =
    redisUrl !== undefined
      ? new RedisQueueTransport({
          client: new Redis(redisUrl, { maxRetriesPerRequest: 1 }) as never,
        })
      : new InMemoryTransport();

  const pool: DevGuardPool | undefined = real(config.databaseUrlRef.name)
    ? createPool({ connectionString: config.databaseUrlRef.name })
    : undefined;

  const registry = new JobRegistry();
  registerWorkflowExecute(
    registry,
    pool !== undefined ? durableRunTransitions(pool) : volatileRunTransitions(),
  );
  const commentAuthorizer = buildWorkerAuthorizer(pool);
  const commentCommands =
    pool !== undefined ? buildCommentCommandService(pool, commentAuthorizer, config) : undefined;
  registerWebhookProcess(
    registry,
    pool !== undefined ? new PostgresWebhookDeliveryStore(pool) : new InMemoryDeliveryStore(),
    { commentCommands },
  );
  registerApprovalResume(registry);
  registerFailClosedHandlers(registry);

  const runtime = new WorkerRuntime(
    registry,
    queue,
    new CancellationFence(),
    undefined,
    {
      queues: [...QUEUE_NAMES],
      leaseMs: 30_000,
      pollIntervalMs: 250,
      maxConcurrent: 10,
      workerId: `worker-${process.pid}`,
    },
    Math.random,
  );

  return {
    config,
    authorizer,
    queue,
    registry,
    runtime,
    transportDurability,
    ...(pool !== undefined ? { pool } : {}),
  };
}

/** Refuse to run the worker on a non-durable queue in production (CP002 §5). */
export function validateWorkerReadiness(
  config: WorkerConfigSnapshot,
  container: WorkerContainer,
): void {
  if (config.environment === 'production' && container.transportDurability !== 'redis') {
    throw configurationInvalid([
      {
        path: 'worker.queue',
        constraint: `production requires a durable Redis QueueTransport; bound: ${container.transportDurability}`,
      },
    ]);
  }
}

/** Honest startup label: 'consuming' only once a durable transport is bound. */
export type WorkerStartupStatus = 'consuming' | 'idle_no_transport';

export function workerStartupStatus(container: WorkerContainer): WorkerStartupStatus {
  return container.transportDurability === 'redis' ? 'consuming' : 'idle_no_transport';
}
