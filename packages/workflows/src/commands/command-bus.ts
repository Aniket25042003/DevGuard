/**
 * CP006 — Command bus (list + submit), shared by every surface.
 *
 * The ONE path that turns a client intent into a durable, queued workflow run:
 *   HTTP/GitHub → CommandBus.submit → normalizeCommandId → MVP/policy gate →
 *   persist run + outbox atomically (persistence port) → receipt.
 *
 * Placed in @devguard/workflows (not apps/api) so the GitHub webhook processor
 * and the worker can call it directly without an HTTP loopback (CP006 §23-6).
 * All persistence goes through a single `CommandBusPersistencePort` whose
 * implant guarantees "run row + outbox event commit or roll back together"
 * (C008 outbox; steering invariant 10). SQL never appears here.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { MANUAL_COMMANDS_V1, normalizeCommandId, type WorkflowIdV1 } from '@devguard/policy-engine';
import { validationFailed } from '@devguard/errors';

/**
 * MVP commands advertised on the list surface. Extensions (dependency_upgrade,
 * repository_health_check, manual_refactor) stay OUT of the initial list and
 * are denied on submit unless a policy snapshot enables them later (CP006 §28
 * conservative default: refuse extensions). Kept as an explicit local constant
 * so the boundary never imports transport DTOs; a cross-package contract test
 * (tests/integration/src/contracts/) pins it to `@devguard/api-contracts`
 * `MVP_COMMAND_IDS_V1`.
 */
export const COMMAND_BUS_MVP_IDS: ReadonlySet<WorkflowIdV1> = new Set([
  'implement_issue',
  'diagnose_failure',
  'security_audit',
  'security_patch',
  'review_remediation',
]);

export type OriginSurfaceV1 = 'web' | 'cli' | 'github_comment' | 'github_event' | 'schedule';
export type TriggerTypeV1 = 'manual' | 'webhook' | 'api' | 'schedule';

/** Fail closed: a NON-MVP (extension) command cannot be launched from the bus. */
export class CommandDisabledError extends Error {
  readonly code = 'COMMAND_NO_LONGER_ALLOWED' as const;
  constructor(readonly workflowId: string) {
    super(`Command '${workflowId}' is not enabled for manual launch.`);
    this.name = 'CommandDisabledError';
  }
}

/** Client asserted an origin surface it is not allowed to set (HTTP). */
export class CommandOriginForgedError extends Error {
  readonly code = 'ORIGIN_FORGED' as const;
  constructor(readonly surface: string) {
    super(`Origin surface '${surface}' cannot be asserted by an HTTP client.`);
    this.name = 'CommandOriginForgedError';
  }
}

export interface SubmitCommandShape {
  /** Client-supplied command reference (canonical id or alias). */
  readonly commandId: string;
  /** Optional payload/instruction supplied by the surface. */
  readonly input?: unknown | undefined;
}

export interface CreateQueuedRunInput {
  readonly runId: string;
  readonly repositoryId: string;
  /** Canonical workflow id (already normalized). */
  readonly workflowType: string;
  readonly triggerType: TriggerTypeV1;
  readonly idempotencyKeyHash: string;
  readonly originSurface: OriginSurfaceV1;
  /** Correlation + outbox payload for the publishable intent. */
  readonly eventPayload: Record<string, unknown>;
  readonly createdBy?: string | undefined;
}

/**
 * Durable persistence abstraction. The implant MUST create the run row and
 * enqueue the outbox event inside ONE transaction (steering invariant 10), and
 * MUST return `replayed` (with the existing run) when the idempotency key hash
 * already produced a run — never a duplicate.
 */
export interface CommandBusPersistencePort {
  createQueuedRun(
    input: CreateQueuedRunInput,
  ): Promise<
    | { readonly outcome: 'created'; readonly runId: string }
    | { readonly outcome: 'replayed'; readonly runId: string }
  >;
}

export interface SubmitResult {
  readonly runId: string;
  readonly replayed: boolean;
}

export interface AvailableCommand {
  readonly workflowId: WorkflowIdV1;
  readonly inputSchemaId: string;
}

export interface CommandBusDeps {
  readonly persistence: CommandBusPersistencePort;
  /** Opaque run-id generator (injectable for deterministic tests). */
  readonly newRunId?: (() => string) | undefined;
}

export function idempotencyKeyHashOf(key: string): string {
  return createHash('sha256').update(`devguard.command.idempotency.v1:${key}`).digest('hex');
}

/** The initial command catalog, filtered to MVP commands (CP006 §28). */
export function listAvailableCommands(): readonly AvailableCommand[] {
  return MANUAL_COMMANDS_V1.filter((definition) =>
    COMMAND_BUS_MVP_IDS.has(definition.workflowId),
  ).map((definition) => ({
    workflowId: definition.workflowId,
    inputSchemaId: definition.inputSchemaId,
  }));
}

export class CommandBus {
  private readonly newRunId: () => string;

  constructor(private readonly deps: CommandBusDeps) {
    this.newRunId = deps.newRunId ?? randomUUID;
  }

  /** Commands the caller may launch (MVP-aware; extensions excluded). */
  listAvailable(): readonly AvailableCommand[] {
    return listAvailableCommands();
  }

  /**
   * Turn a submitted command into a durable queued run. Normalizes the command
   * (unknown → COMMAND_UNKNOWN), gates MVP/policy (extension → denied), and
   * persists atomically via the persistence port.
   */
  async submit(input: {
    readonly command: SubmitCommandShape;
    readonly repositoryId: string;
    /** Server-derived origin surface for THIS call (never trusted from body). */
    readonly originSurface: OriginSurfaceV1;
    readonly idempotencyKey: string;
    readonly createdBy?: string | undefined;
    /** `true` when the caller is the server-side GitHub/woker path, not HTTP. */
    readonly trustedSurface?: boolean | undefined;
  }): Promise<SubmitResult> {
    const workflowId = normalizeCommandId(input.command.commandId);
    if (!COMMAND_BUS_MVP_IDS.has(workflowId)) {
      throw new CommandDisabledError(workflowId);
    }
    if (
      input.trustedSurface !== true &&
      input.originSurface !== 'web' &&
      input.originSurface !== 'cli'
    ) {
      throw new CommandOriginForgedError(input.originSurface);
    }
    if (input.idempotencyKey.trim().length < 16) {
      throw validationFailed([{ path: 'idempotencyKey', constraint: 'min_length_16' }]);
    }

    const runId = this.newRunId();
    const idempotencyKeyHash = idempotencyKeyHashOf(input.idempotencyKey);
    const persisted = await this.deps.persistence.createQueuedRun({
      runId,
      repositoryId: input.repositoryId,
      workflowType: workflowId,
      triggerType:
        input.originSurface === 'github_comment' || input.originSurface === 'github_event'
          ? 'webhook'
          : 'manual',
      idempotencyKeyHash,
      originSurface: input.originSurface,
      eventPayload: {
        commandId: workflowId,
        repositoryId: input.repositoryId,
        originSurface: input.originSurface,
        ...(input.command.input !== undefined ? { input: input.command.input } : {}),
      },
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    });

    return { runId: persisted.runId, replayed: persisted.outcome === 'replayed' };
  }
}
