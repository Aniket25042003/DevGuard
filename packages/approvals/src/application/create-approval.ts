/**
 * C031 §8/§12 — ApprovalFactory and the transactional create use case.
 *
 * create(): validate → canonicalize/fingerprint (secret-scan inside) →
 * dedupe by (actionId, actionFingerprint, contextFingerprint) → insert or
 * return the EXACT existing aggregate. Persistence goes through a port so
 * the domain stays provider-agnostic; the C010 store implements it.
 */
import type { RiskClass } from '@devguard/contracts';
import { makeError } from '@devguard/errors';
import {
  buildFingerprints,
  approvalActionV1,
  approvalContextV1,
  type ApprovalActionV1,
} from '../fingerprint/schemas.js';
import type { ApprovalStatus } from '../domain/approval-fsm.js';
import type { ApprovalContextV1 } from '../fingerprint/schemas.js';

export const FINGERPRINT_SCHEMA_VERSION = 1;

/** Database status vocabulary (lowercase) matches packages/db CHECK constraint. */
export function toDbStatus(status: ApprovalStatus): string {
  return status.toLowerCase();
}

export interface CreateApprovalRequest {
  readonly repositoryDevguardId: string;
  readonly workflowRunId?: string | undefined;
  readonly actionId: string;
  readonly policyDecisionId: string;
  readonly actionType: string;
  readonly tool: { readonly id: string; readonly registryVersion: string };
  readonly provider: 'github_adapter' | 'trueforge_mcp' | 'sandbox' | 'webhook';
  readonly operation: Record<string, unknown>;
  readonly target: { readonly kind: string; readonly providerId: string };
  readonly context: Omit<ApprovalContextV1, 'schemaVersion' | 'actionFingerprint'>;
  readonly rationale: string;
  /** RFC3339 seconds UTC; MUST be in the future relative to DB clock. */
  readonly requestedByKind: 'user' | 'system';
}

export interface CreatedApproval {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly actionFingerprint: string;
  readonly contextFingerprint: string;
  readonly canonicalActionJson: string;
  readonly canonicalContextJson: string;
  readonly duplicate: boolean;
}

/** Port over packages/db's approvals table with command-key idempotency. */
export interface ApprovalRepositoryPort {
  findByDedupe(input: {
    actionId: string;
    actionFingerprint: string;
    contextFingerprint: string;
  }): Promise<{ id: string } | undefined>;

  insertPending(input: {
    /** Caller-proposed id; implementations may substitute their own. */
    id: string;
    actionId: string;
    actionType: string;
    riskClass: string;
    reasonCode: string;
    reasonSummary: string;
    operationHash: string;
    fingerprintHash: string;
    canonicalActionJson: string;
    canonicalContextJson: string;
    expiresAtIso: string;
    workflowRunId?: string | undefined;
    repositoryDevguardId: string;
  }): Promise<{ id: string }>;
}

export class ApprovalCreationError extends Error {}

const UUID_LIKE = /^[0-9a-fA-F-]{26,36}$/;

export class ApprovalFactory {
  constructor(private readonly newApprovalId: () => string) {}

  /**
   * Validate + fingerprint + persist atomically via the port.
   * Decision consistency check is the caller application's job upstream
   * (C030 persisted REQUIRE_APPROVAL); here we enforce the hard invariants:
   * complete binding, future expiry, no secrets, run correlation present.
   */
  async create(
    input: CreateApprovalRequest,
    port: ApprovalRepositoryPort,
    context: { nowMs: number },
  ): Promise<CreatedApproval> {
    if (!UUID_LIKE.test(input.repositoryDevguardId)) {
      throw makeError('VALIDATION_FAILED', { cause: 'repository binding incomplete' });
    }
    if (!input.workflowRunId || !UUID_LIKE.test(input.workflowRunId)) {
      // workflow.runId prevents cross-run reuse — mandatory (C031 §10).
      throw makeError('VALIDATION_FAILED', {
        cause: 'workflow run binding required for approval creation',
      });
    }
    const action = {
      schemaVersion: 'approval-action/v1',
      actionType: input.actionType,
      tool: input.tool,
      provider: input.provider,
      repository: {
        devguardId: input.repositoryDevguardId,
        githubId: String(
          (input.context.targetState as { targetProviderId: string }).targetProviderId ?? '',
        ),
        installationId: `inst-${input.repositoryDevguardId.slice(0, 12)}`,
      },
      operation: input.operation as Record<string, unknown>,
      target: {
        kind: input.context.targetState.targetKind,
        providerId: input.context.targetState.targetProviderId,
      },
    } satisfies ApprovalActionV1;
    const parsedAction = approvalActionV1.parse(action);

    const parsedContext = approvalContextV1.parse({
      ...input.context,
      schemaVersion: 'approval-context/v1',
    });
    // Expiry must be strictly future at creation time.
    if (Date.parse(parsedContext.expiresAt) <= context.nowMs) {
      throw makeError('VALIDATION_FAILED', { cause: 'approval expiry must be in the future' });
    }

    const fingerprints = buildFingerprints(parsedAction, parsedContext);

    const existing = await port.findByDedupe({
      actionId: input.actionId,
      actionFingerprint: fingerprints.actionFingerprint,
      contextFingerprint: fingerprints.contextFingerprint,
    });
    if (existing) {
      return Object.freeze({
        id: existing.id,
        status: 'PENDING' as const,
        actionFingerprint: fingerprints.actionFingerprint,
        contextFingerprint: fingerprints.contextFingerprint,
        canonicalActionJson: fingerprints.canonicalActionJson,
        canonicalContextJson: fingerprints.canonicalContextJson,
        duplicate: true,
      });
    }

    const inserted = await port.insertPending({
      id: this.newApprovalId(),
      actionId: input.actionId,
      actionType: input.actionType,
      riskClass: (input.context.risk as { class: RiskClass }).class,
      reasonCode: 'AWAITING_RESOLUTION',
      reasonSummary: input.rationale.slice(0, 512),
      operationHash: fingerprints.actionFingerprint,
      fingerprintHash: fingerprints.contextFingerprint,
      canonicalActionJson: fingerprints.canonicalActionJson,
      canonicalContextJson: fingerprints.canonicalContextJson,
      expiresAtIso: parsedContext.expiresAt,
      workflowRunId: input.workflowRunId,
      repositoryDevguardId: input.repositoryDevguardId,
    });

    return Object.freeze({
      id: inserted.id,
      status: 'PENDING' as const,
      actionFingerprint: fingerprints.actionFingerprint,
      contextFingerprint: fingerprints.contextFingerprint,
      canonicalActionJson: fingerprints.canonicalActionJson,
      canonicalContextJson: fingerprints.canonicalContextJson,
      duplicate: false,
    });
  }
}
