/**
 * C006/CP002 — Worker composition root.
 *
 * Workers act ONLY as scoped system actors bound to persisted runs/approvals.
 * No user principals exist here; forged user actors cannot be constructed.
 *
 * CP002: the worker composes the durable queue substrate (C057). Until a
 * durable Redis `QueueTransport` is wired (CP008), the default binding is the
 * in-memory transport, which `validateWorkerReadiness` REFUSES in production so
 * the worker never silently runs on a non-durable queue in a real environment.
 */
import {
  RepositoryAuthorizationService,
  type AuthorizationEvidencePort,
  type GitHubPermissionPort,
  type LocalRepositoryAccessPort,
} from '@devguard/authorization';
import type { WorkerConfigSnapshot } from '@devguard/config';
import { configurationInvalid } from '@devguard/errors';
import { InMemoryTransport, type QueueTransport } from '@devguard/queue';

/** Shared fail-closed stubs until their owning components land. */
export class UnavailableGitHubPermissionPort implements GitHubPermissionPort {
  async fetchUserRole(): Promise<{ role: 'none'; snapshotHash: string }> {
    throw new Error('github_permission_port_unavailable');
  }
}

export class EmptyLocalRepositoryAccessPort implements LocalRepositoryAccessPort {
  async findLinkage(): Promise<undefined> {
    return undefined;
  }

  async isConnectingOwner(): Promise<boolean> {
    return false;
  }
}

export interface WorkerContainer {
  readonly config: WorkerConfigSnapshot;
  readonly authorizer: RepositoryAuthorizationService;
  /** Durable queue substrate; InMemoryTransport is volatile and refused in production. */
  readonly queue: QueueTransport;
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

  // InMemoryTransport is the pre-CP008 default and never ships to production.
  const queue: QueueTransport = new InMemoryTransport();

  return { config, authorizer, queue };
}

const VOLATILE_QUEUE_NAME = 'in_memory';

/** Refuse to run the worker on a non-durable queue in production (CP002 §5). */
export function validateWorkerReadiness(
  config: WorkerConfigSnapshot,
  container: WorkerContainer,
): void {
  if (config.environment === 'production' && container.queue instanceof InMemoryTransport) {
    throw configurationInvalid([
      {
        path: 'worker.queue',
        constraint: `production requires a durable QueueTransport; bound: ${VOLATILE_QUEUE_NAME}`,
      },
    ]);
  }
}

/** Honest startup label: 'consuming' once CP008 wires a durable transport. */
export type WorkerStartupStatus = 'consuming' | 'idle_no_transport';

export function workerStartupStatus(container: WorkerContainer): WorkerStartupStatus {
  return container.queue instanceof InMemoryTransport ? 'idle_no_transport' : 'consuming';
}
