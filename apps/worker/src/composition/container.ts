/**
 * CP008 — Worker composition root (BullMQ delivery + typed consumers).
 *
 * Workers act ONLY as scoped system actors bound to persisted runs/approvals.
 * No user principals exist here; forged user actors cannot be constructed.
 *
 * Production binds BullMQ to Redis and leaves PostgreSQL authoritative through
 * the independent outbox relay. The in-memory transport remains a test-only
 * fallback and is refused by readiness checks outside test/development.
 */
import { Redis } from 'ioredis';
import {
  AgentSessionService,
  InMemorySessionStore,
  InMemoryTurnStore,
  TrueForgeSdkAgentRuntime,
  type AgentRuntimePort,
  type SessionStorePort,
  type TurnStorePort,
} from '@devguard/agent';
import {
  RepositoryAuthorizationService,
  type AuthorizationEvidencePort,
  type LocalRepositoryAccessPort,
} from '@devguard/authorization';
import type { WorkerConfigSnapshot } from '@devguard/config';
import { configurationInvalid } from '@devguard/errors';
import {
  CancellationFence,
  InMemoryDeliveryStore,
  InMemoryTransport,
  BullMqQueue,
  BullMqWorkerRuntime,
  JobRegistry,
  Queue,
  QUEUE_NAMES,
  WorkerRuntime,
  type QueueTransport,
  type QueuePortShape,
} from '@devguard/queue';
import {
  createPool,
  PostgresAgentSessionStore,
  PostgresAgentTurnStore,
  PostgresApprovalResumeStore,
  PostgresArtifactRetentionCleaner,
  PostgresLocalRepositoryAccessPort,
  OutboxRepository,
  PostgresWebhookDeliveryStore,
  type DevGuardPool,
} from '@devguard/db';
import {
  durableRunTransitions,
  registerApprovalResume,
  registerFailClosedHandlers,
  registerUnavailablePersistenceHandlers,
  registerWebhookProcess,
  registerWorkflowExecute,
  volatileRunTransitions,
} from './handlers.js';
import { buildCommentCommandService, buildWorkerAuthorizer } from './comment-commands.js';
import { buildGitHubPermissionPort } from './github-permission-port.js';
import { registerOutboxPublish } from './outbox-publish.js';
import { registerRetentionCleanup } from './retention-cleanup.js';
import { EmptyLocalRepositoryAccessPort } from './stubs.js';

export interface WorkerContainer {
  readonly config: WorkerConfigSnapshot;
  readonly authorizer: RepositoryAuthorizationService;
  /** Durable Redis queue substrate; InMemoryTransport is volatile and refused in production. */
  readonly queue: QueueTransport | BullMqQueue;
  readonly registry: JobRegistry;
  readonly runtime: WorkerRuntime | BullMqWorkerRuntime;
  readonly transportDurability: 'redis' | 'in_memory';
  readonly pool?: DevGuardPool | undefined;
  readonly agentRuntime: AgentRuntimePort;
  readonly agentSessions: AgentSessionService;
  /** Dedicated health connection; queue/worker connections are owned by BullMQ. */
  readonly redisHealth?: Redis | undefined;
}

function real(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && !value.startsWith('<');
}

function isPostgresDsn(value: string | undefined): value is string {
  if (value === undefined || value === '' || value.startsWith('<')) return false;
  return value.startsWith('postgres://') || value.startsWith('postgresql://');
}

function isRedisDsn(value: string | undefined): value is string {
  return value !== undefined && (value.startsWith('redis://') || value.startsWith('rediss://'));
}

export function buildWorkerContainer(config: WorkerConfigSnapshot): WorkerContainer {
  const pool: DevGuardPool | undefined = isPostgresDsn(config.databaseUrlRef.name)
    ? createPool({ connectionString: config.databaseUrlRef.name })
    : undefined;

  const privateKeyPem =
    config.github !== undefined && real(config.github.privateKeyRef)
      ? config.github.privateKeyRef
      : undefined;
  const githubPermissions = buildGitHubPermissionPort(pool, config.github, privateKeyPem);
  const localAccess: LocalRepositoryAccessPort =
    pool !== undefined
      ? new PostgresLocalRepositoryAccessPort(pool)
      : new EmptyLocalRepositoryAccessPort();
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

  const redisUrl = isRedisDsn(config.redisUrlRef.name) ? config.redisUrlRef.name : undefined;
  const agentRuntime: AgentRuntimePort = new TrueForgeSdkAgentRuntime({
    enabled: config.features.trueforgeIntegrationEnabled.value && config.trueforge !== undefined,
    baseUrl: config.trueforge?.baseUrl ?? 'http://trueforge.invalid',
    ...(config.trueforge?.apiKeyRef !== undefined ? { apiKey: config.trueforge.apiKeyRef } : {}),
    timeoutMs: config.trueforge?.timeoutMs,
  });
  const sessionStore: SessionStorePort = (pool !== undefined
    ? new PostgresAgentSessionStore(pool)
    : new InMemorySessionStore()) as unknown as SessionStorePort;
  const turnStore: TurnStorePort = (pool !== undefined
    ? new PostgresAgentTurnStore(pool)
    : new InMemoryTurnStore()) as unknown as TurnStorePort;
  const agentSessions = new AgentSessionService({
    runtime: agentRuntime,
    sessions: sessionStore,
    turns: turnStore,
    agentVersion: 'devguard-mvp@1.0.0',
  });
  const transportDurability = redisUrl !== undefined ? 'redis' : 'in_memory';
  const redisHealth =
    redisUrl !== undefined
      ? new Redis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: true, lazyConnect: true })
      : undefined;
  const queue: QueueTransport | BullMqQueue =
    redisUrl !== undefined
      ? new BullMqQueue({
          connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) as never,
        })
      : new InMemoryTransport();
  const approvalQueue: QueuePortShape =
    redisUrl !== undefined ? (queue as BullMqQueue) : new Queue(queue as QueueTransport);

  const registry = new JobRegistry();
  registerWorkflowExecute(
    registry,
    pool !== undefined ? durableRunTransitions(pool) : volatileRunTransitions(),
  );
  const commentAuthorizer = buildWorkerAuthorizer(pool, githubPermissions);
  const commentCommands =
    pool !== undefined ? buildCommentCommandService(pool, commentAuthorizer, config) : undefined;
  registerWebhookProcess(
    registry,
    pool !== undefined ? new PostgresWebhookDeliveryStore(pool) : new InMemoryDeliveryStore(),
    { commentCommands },
  );
  registerApprovalResume(
    registry,
    pool !== undefined
      ? {
          store: new PostgresApprovalResumeStore(pool),
          queue: approvalQueue,
          workerId: `worker-${process.pid}`,
        }
      : undefined,
  );
  if (pool !== undefined) {
    registerOutboxPublish(registry, {
      outbox: new OutboxRepository(pool),
      queue,
      workerId: `worker-${process.pid}`,
    });
    registerRetentionCleanup(registry, {
      cleaner: new PostgresArtifactRetentionCleaner(pool),
    });
  } else {
    registerUnavailablePersistenceHandlers(registry);
  }
  registerFailClosedHandlers(registry);

  const runtime =
    redisUrl !== undefined
      ? new BullMqWorkerRuntime({
          connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) as never,
          queues: [...QUEUE_NAMES],
          registry,
          concurrency: 10,
        })
      : new WorkerRuntime(
          registry,
          queue as QueueTransport,
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
    agentRuntime,
    agentSessions,
    ...(redisHealth !== undefined ? { redisHealth } : {}),
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

/** Live dependency checks used before advertising worker readiness. */
export async function checkWorkerReadiness(
  container: WorkerContainer,
): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
  const reasons: string[] = [];
  if (container.pool !== undefined && !(await container.pool.health()).ok) reasons.push('database');
  if (container.redisHealth !== undefined) {
    try {
      if ((await container.redisHealth.ping()) !== 'PONG') reasons.push('redis');
    } catch {
      reasons.push('redis');
    }
  } else if (container.config.environment === 'production') {
    reasons.push('redis');
  }
  if (container.config.features.trueforgeIntegrationEnabled.value) {
    const probe = container.agentRuntime.preflight;
    if (probe === undefined) reasons.push('trueforge');
    else if (!(await probe.call(container.agentRuntime)).ok) reasons.push('trueforge');
  }
  if (container.config.environment === 'production' && container.config.artifacts.driver !== 's3') {
    reasons.push('artifact-storage');
  }
  return { ok: reasons.length === 0, reasons };
}
