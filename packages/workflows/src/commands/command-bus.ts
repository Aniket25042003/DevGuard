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
import {
  MANUAL_COMMANDS_V1,
  normalizeCommandId,
  validateManualCommandInput,
  type WorkflowIdV1,
} from '@devguard/policy-engine';
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
  /** Requested workflow definition version (raw string, e.g. "1.0.0"). */
  readonly definitionVersion?: string | undefined;
  /** Optional payload/instruction supplied by the surface. */
  readonly input?: unknown | undefined;
}

export type SupportedTriggerTypeV1 = 'manual' | 'webhook';

export interface CreateQueuedRunInput {
  readonly runId: string;
  readonly repositoryId: string;
  /** Canonical workflow id (already normalized). */
  readonly workflowType: string;
  readonly triggerType: SupportedTriggerTypeV1;
  readonly idempotencyKeyHash: string;
  readonly originSurface: OriginSurfaceV1;
  /**
   * Canonical `workflow.queued` event payload (matches the registered C004
   * schema: repositoryId + trigger [+ requestedBy]). Command-specific context
   * travels in the outbox correlation, NOT in the validated event payload.
   */
  readonly eventPayload: Record<string, unknown>;
  /**
   * Deterministic digest over the full creation request so a replayed
   * idempotency key is honored ONLY when it is an exact replay — a same key
   * with a different repository/command/version/input is a conflict (CP006).
   */
  readonly requestFingerprint: string;
  /** Requested definition version (raw string) for persistence/audit. */
  readonly definitionVersion?: string | undefined;
  readonly createdBy?: string | undefined;
}

/**
 * Durable persistence abstraction. The implant MUST create the run row and
 * enqueue the outbox event inside ONE transaction (steering invariant 10).
 * When the idempotency key hash already produced a run, the implant MUST
 * compare the stored `requestFingerprint`: an exact replay returns `replayed`;
 * a mismatched reuse throws an idempotency conflict. Never a duplicate.
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
  readonly commandId: WorkflowIdV1;
  readonly originSurface: OriginSurfaceV1;
  readonly createdAt: string;
}

export interface AvailableCommand {
  readonly workflowId: WorkflowIdV1;
  readonly inputSchemaId: string;
}

export interface CommandBusDeps {
  readonly persistence: CommandBusPersistencePort;
  /** Opaque run-id generator (injectable for deterministic tests). */
  readonly newRunId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
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
  private readonly now: () => Date;

  constructor(private readonly deps: CommandBusDeps) {
    this.newRunId = deps.newRunId ?? randomUUID;
    this.now = deps.now ?? (() => new Date());
  }

  /** Commands the caller may launch (MVP-aware; extensions excluded). */
  listAvailable(): readonly AvailableCommand[] {
    return listAvailableCommands();
  }

  /**
   * Turn a submitted command into a durable queued run. Normalizes the command
   * (unknown → COMMAND_UNKNOWN), gates MVP/policy (extension → denied), rejects
   * forged origins and unsupported schedule provenance, then persists the run +
   * outbox atomically via the persistence port. A replayed idempotency key must
   * be an EXACT replay (same fingerprint) or it conflicts (idempotencyKeyConflict).
   */
  async submit(input: {
    readonly command: SubmitCommandShape;
    readonly repositoryId: string;
    /** Server-derived origin surface for THIS call (never trusted from body). */
    readonly originSurface: OriginSurfaceV1;
    readonly idempotencyKey: string;
    readonly createdBy?: string | undefined;
    /** `true` when the caller is the server-side GitHub/worker path, not HTTP. */
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
    // Schedule provenance is NOT persistable yet (DB trigger_type + the C004
    // event contract accept only manual|webhook|api). Fail closed instead of
    // coercing a scheduled run into a manual one (CP006 §22 finding).
    if (input.originSurface === 'schedule') {
      throw validationFailed([{ path: 'originSurface', constraint: 'schedule_not_supported_yet' }]);
    }
    if (input.idempotencyKey.trim().length < 16) {
      throw validationFailed([{ path: 'idempotencyKey', constraint: 'min_length_16' }]);
    }
    if (input.command.input !== undefined && !isPlainJsonObject(input.command.input)) {
      throw validationFailed([{ path: 'input', constraint: 'must be a JSON object' }]);
    }
    const normalizedInput =
      input.command.input !== undefined &&
      (input.originSurface === 'web' || input.originSurface === 'cli')
        ? validateManualCommandInput(workflowId, input.command.input)
        : input.command.input;
    const definitionVersion = normalizeDefinitionVersion(input.command.definitionVersion);

    const triggerType: SupportedTriggerTypeV1 =
      input.originSurface === 'github_comment' || input.originSurface === 'github_event'
        ? 'webhook'
        : 'manual';
    const createdAt = this.now().toISOString();
    const requestFingerprint = canonicalRequestFingerprint({
      commandId: workflowId,
      repositoryId: input.repositoryId,
      originSurface: input.originSurface,
      ...(definitionVersion !== undefined ? { definitionVersion } : {}),
      ...(normalizedInput !== undefined ? { input: normalizedInput } : {}),
    });
    const runId = this.newRunId();
    const idempotencyKeyHash = idempotencyKeyHashOf(input.idempotencyKey);

    const persisted = await this.deps.persistence.createQueuedRun({
      runId,
      repositoryId: input.repositoryId,
      workflowType: workflowId,
      triggerType,
      idempotencyKeyHash,
      originSurface: input.originSurface,
      // Canonical C004 workflow.queued payload: repositoryId + trigger (+ actor).
      eventPayload: {
        repositoryId: input.repositoryId,
        trigger: triggerType,
        ...(input.createdBy !== undefined ? { requestedBy: input.createdBy } : {}),
      },
      requestFingerprint,
      ...(definitionVersion !== undefined ? { definitionVersion } : {}),
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    });

    return {
      runId: persisted.runId,
      replayed: persisted.outcome === 'replayed',
      commandId: workflowId,
      originSurface: input.originSurface,
      createdAt,
    };
  }
}

/** Reject empty/malformed definition versions (exact pass-through otherwise). */
function normalizeDefinitionVersion(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > 64) {
    throw validationFailed([{ path: 'definitionVersion', constraint: '1..64 chars' }]);
  }
  return value;
}

/** Plain (non-array, non-null) JSON-object guard for command input. */
function isPlainJsonObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deterministic, key-sorted JSON so an exact replay has a stable fingerprint. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalRequestFingerprint(value: Record<string, unknown>): string {
  return stableStringify(value);
}
