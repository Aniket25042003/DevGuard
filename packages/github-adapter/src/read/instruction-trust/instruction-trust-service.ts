/**
 * C016 §10/§12 — the instruction trust service.
 *
 * Assembles an immutable `InstructionSnapshot` bound to exact policy/workflow/ref
 * versions, applying a fixed precedence: global safety → repository policy →
 * workflow rules → repository instructions → task request → repository
 * content/comments (data, untrusted). Missing authoritative tiers reject; lower
 * tiers may narrow style/scope but CANNOT modify authority, tools, approvals,
 * secrets, network, sandbox, validation obligations, action risk, or global
 * constraints. Ambiguity affecting safety rejects rather than deferring to the
 * model. Output separates authoritative constraints / advisory instructions /
 * untrusted task data — never a single flattened authority-free string.
 */
import { randomUUID } from 'node:crypto';
import { makeError } from '@devguard/errors';
import type { EmittedReadEvent, EventSinkPort } from '../ports/shared.js';
import {
  AUTHORITATIVE_TIERS,
  ADVISORY_TIERS,
  UNTRUSTED_TIERS,
  assembleInstructionSnapshotSchema,
  resolveInstructionsForPathSchema,
  validateInstructionCandidateSchema,
  type AssembleInstructionSnapshotInput,
  type InstructionSegment,
  type InstructionSnapshot,
  type InstructionTier,
  type InstructionValidation,
  type InstructionConflict,
  type RejectedDirective,
  type ResolvedInstructionSet,
  type ResolveInstructionsForPathInput,
  type ValidateInstructionCandidateInput,
} from './contracts.js';
import { classifyDirective, reasonCodeForCategory } from './directive-classifier.js';
import { pathMatchesScope } from './applicability-resolver.js';
import {
  InMemoryInstructionSnapshotStore,
  type InstructionSnapshotStorePort,
} from './instruction-snapshot-store.js';
import { canonicalize, sha256Hex } from './digest.js';
import type { DirectiveCategory } from './contracts.js';

export const MAX_SEGMENTS = 2000;
export const MAX_LINE_BYTES = 400;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** A loaded, exact-ref-bound instruction source (content included). */
export interface RawInstructionSource {
  readonly id: string;
  readonly origin: string;
  readonly immutableRef: string;
  readonly content: string;
  readonly path?: string | undefined;
  readonly scope?: string | undefined;
}

/** Port resolving trusted + discovered instruction sources (provider-neutral). */
export interface InstructionContentPort {
  resolveGlobalSafety(): Promise<readonly RawInstructionSource[]>;
  resolvePolicy(policyVersionId: string): Promise<readonly RawInstructionSource[]>;
  resolveWorkflow(workflowDefinitionVersion: string): Promise<readonly RawInstructionSource[]>;
  resolveTaskRequest(taskRequestRef: string): Promise<readonly RawInstructionSource[]>;
  discoverRepositoryInstructions(headSha: string): Promise<readonly RawInstructionSource[]>;
}

export interface InstructionTrustServiceDeps {
  readonly port: InstructionContentPort;
  readonly store?: InstructionSnapshotStorePort | undefined;
  readonly clock?: { readonly nowIso: () => string };
  readonly emit?: EventSinkPort;
}

export interface InstructionTrustService {
  assemble(input: AssembleInstructionSnapshotInput): Promise<InstructionSnapshot>;
  resolveForPath(input: ResolveInstructionsForPathInput): Promise<ResolvedInstructionSet>;
  validate(input: ValidateInstructionCandidateInput): Promise<InstructionValidation>;
}

export class InstructionTrustServiceGate implements InstructionTrustService {
  readonly #port: InstructionContentPort;
  readonly #store: InstructionSnapshotStorePort;
  readonly #clock: { readonly nowIso: () => string };
  readonly #emit: EventSinkPort;

  constructor(deps: InstructionTrustServiceDeps) {
    this.#port = deps.port;
    this.#store = deps.store ?? new InMemoryInstructionSnapshotStore();
    this.#clock = deps.clock ?? { nowIso: () => new Date().toISOString() };
    this.#emit = deps.emit ?? new NoopEventSink();
  }

  async assemble(input: AssembleInstructionSnapshotInput): Promise<InstructionSnapshot> {
    const parsed = assembleInstructionSnapshotSchema.safeParse(input);
    if (!parsed.success) {
      throw makeError('VALIDATION_FAILED', {
        details: { reasonCode: 'INSTRUCTION_ASSEMBLE_INPUT' },
      });
    }
    const operation = parsed.data;

    const existing = await this.#store.findByOperationKey(operation.operationKey);
    if (existing !== undefined && existing.status !== 'superseded') {
      const sameBinding =
        existing.repositoryId === operation.repositoryId &&
        existing.workflowRunId === operation.workflowRunId &&
        existing.headSha === operation.headSha &&
        existing.policyVersionId === operation.policyVersionId &&
        existing.workflowDefinitionVersion === operation.workflowDefinitionVersion &&
        existing.taskRequestRef === operation.taskRequestRef;
      if (sameBinding) return existing;
      throw makeError('CONFLICT', { details: { reasonCode: 'OPERATION_KEY_BINDING_MISMATCH' } });
    }

    // 1. Load authoritative tiers; a missing authoritative tier rejects.
    const [global, policy, workflow] = await Promise.all([
      this.#port.resolveGlobalSafety(),
      this.#port.resolvePolicy(operation.policyVersionId),
      this.#port.resolveWorkflow(operation.workflowDefinitionVersion),
    ]);
    const missingAuthoritative = [
      ...(global.length === 0 ? (['global_safety'] as const) : []),
      ...(policy.length === 0 ? (['repository_policy'] as const) : []),
      ...(workflow.length === 0 ? (['workflow_rule'] as const) : []),
    ];
    if (missingAuthoritative.length > 0) {
      const rejected = this.#buildSnapshot(
        operation,
        [],
        [
          {
            sourceId: 'assemble',
            tier: 'global_safety',
            reasonCode: 'MISSING_TRUSTED_TIER',
            snippetHash: '',
            detail: missingAuthoritative.join(', '),
          },
        ],
        [],
        'rejected',
        `missing authoritative tier: ${missingAuthoritative.join(', ')}`,
        [],
      );
      await this.#store.save(rejected);
      await this.#emitEvent('instruction.snapshot.created', operation.workflowRunId, {
        repositoryId: operation.repositoryId,
        snapshotId: rejected.id,
        status: rejected.status,
      });
      return rejected;
    }

    // 2. Load advisory sources.
    const task = await this.#port.resolveTaskRequest(operation.taskRequestRef);
    const repository = await this.#port.discoverRepositoryInstructions(operation.headSha);

    // 3. Segment + classify; reject authority/safety-override directives from
    //    advisory/untrusted tiers; authoritative segments are kept verbatim.
    const segments: InstructionSegment[] = [];
    const rejected: RejectedDirective[] = [];
    const conflicts: InstructionConflict[] = [];
    let totalBytes = 0;
    let truncated = false;

    enumerateGroups: for (const group of [
      { tier: 'global_safety' as InstructionTier, sources: global },
      { tier: 'repository_policy' as InstructionTier, sources: policy },
      { tier: 'workflow_rule' as InstructionTier, sources: workflow },
      // Precedence order (C016 §4): repository instructions rank above task
      // requests, so process repository_instruction BEFORE task_request.
      { tier: 'repository_instruction' as InstructionTier, sources: repository },
      { tier: 'task_request' as InstructionTier, sources: task },
    ]) {
      for (const source of group.sources) {
        await this.#emitEvent('instruction.loaded', source.id, {
          tier: group.tier,
          path: source.path,
          bytes: source.content.length,
        });
        const applicablePaths = (source.scope ?? '**')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const line of source.content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          if (totalBytes >= MAX_SNAPSHOT_BYTES || segments.length >= MAX_SEGMENTS) {
            truncated = true;
            break enumerateGroups;
          }
          totalBytes += Buffer.byteLength(trimmed, 'utf8');
          // Stored text is sanitized (control chars neutralized) so assembly
          // agrees with the classifier and smuggling via control chars is
          // defeated at rest (C016 §17), not only in the matching copy.
          const text = sanitizeLine(trimmed).slice(0, MAX_LINE_BYTES);
          const classification = classifyDirective(text);

          if (AUTHORITATIVE_TIERS.includes(group.tier)) {
            segments.push({
              sourceId: source.id,
              tier: group.tier,
              category: classification.category,
              text,
              ...(applicablePaths.length > 0 ? { applicablePaths } : {}),
            });
            continue;
          }

          if (classification.grantsAuthority || classification.overridesSafety) {
            const reasonCode = reasonCodeForCategory(classification.category) ?? 'AMBIGUOUS_SAFETY';
            rejected.push({
              sourceId: source.id,
              tier: group.tier,
              reasonCode,
              snippetHash: sha256Hex(text),
              detail: `${source.path ?? source.id}: ${classification.category}`,
            });
            conflicts.push({
              higherTier: governingTier(classification.category, group.tier),
              lowerTier: group.tier,
              reasonCode,
              detail: `${source.path ?? source.id}`,
            });
            await this.#emitEvent('instruction.rejected', source.id, {
              tier: group.tier,
              reasonCode,
            });
          } else {
            segments.push({
              sourceId: source.id,
              tier: group.tier,
              category: classification.category,
              text,
              ...(applicablePaths.length > 0 ? { applicablePaths } : {}),
            });
          }
        }
      }
    }

    await this.#emitEvent('instruction.conflict.detected', operation.workflowRunId, {
      repositoryId: operation.repositoryId,
      count: conflicts.length,
    });

    const snapshot = this.#buildSnapshot(
      operation,
      segments,
      rejected,
      conflicts,
      'resolved',
      undefined,
      [],
      truncated,
    );
    const saved = await this.#store.save(snapshot);
    if (!saved.ok) {
      const superseded = this.#buildSnapshot(
        operation,
        segments,
        rejected,
        conflicts,
        'superseded',
        `binding superseded by newer versions: ${saved.code}`,
        [],
        truncated,
      );
      await this.#store.save(superseded);
      await this.#emitEvent('instruction.snapshot.superseded', operation.workflowRunId, {
        repositoryId: operation.repositoryId,
        snapshotId: superseded.id,
      });
      return superseded;
    }

    await this.#emitEvent('instruction.snapshot.created', operation.workflowRunId, {
      repositoryId: operation.repositoryId,
      snapshotId: snapshot.id,
      status: snapshot.status,
      segments: snapshot.segments.length,
      rejected: snapshot.rejectedDirectives.length,
    });
    return snapshot;
  }

  async resolveForPath(input: ResolveInstructionsForPathInput): Promise<ResolvedInstructionSet> {
    const parsed = resolveInstructionsForPathSchema.safeParse(input);
    if (!parsed.success) {
      throw makeError('VALIDATION_FAILED', {
        details: { reasonCode: 'INSTRUCTION_RESOLVE_INPUT' },
      });
    }
    const { snapshotId, path } = parsed.data;
    const snapshot = await this.#store.get(snapshotId);
    if (snapshot === undefined || snapshot.status !== 'resolved') {
      return {
        snapshotId,
        advisoryInstructions: [],
        authoritativeConstraints: [],
        untrustedTaskData: [],
      };
    }

    const authoritativeConstraints: InstructionSegment[] = [];
    const advisoryInstructions: InstructionSegment[] = [];
    const untrustedTaskData: InstructionSegment[] = [];
    for (const segment of snapshot.segments) {
      if (AUTHORITATIVE_TIERS.includes(segment.tier)) {
        authoritativeConstraints.push(segment);
        continue;
      }
      if (!segmentApplies(segment, path)) continue;
      if (ADVISORY_TIERS.includes(segment.tier)) advisoryInstructions.push(segment);
      if (UNTRUSTED_TIERS.includes(segment.tier)) untrustedTaskData.push(segment);
    }
    return { snapshotId, advisoryInstructions, authoritativeConstraints, untrustedTaskData };
  }

  async validate(input: ValidateInstructionCandidateInput): Promise<InstructionValidation> {
    const parsed = validateInstructionCandidateSchema.safeParse(input);
    if (!parsed.success) {
      throw makeError('VALIDATION_FAILED', {
        details: { reasonCode: 'INSTRUCTION_VALIDATE_INPUT' },
      });
    }
    const candidate = parsed.data;
    const classification = classifyDirective(candidate.text);
    const denies = classification.grantsAuthority || classification.overridesSafety;
    return denies
      ? {
          category: classification.category,
          accepted: false,
          reasonCode: reasonCodeForCategory(classification.category) ?? 'AMBIGUOUS_SAFETY',
        }
      : { category: classification.category, accepted: true };
  }

  #buildSnapshot(
    operation: AssembleInstructionSnapshotInput,
    segments: readonly InstructionSegment[],
    rejected: readonly RejectedDirective[],
    conflicts: readonly InstructionConflict[],
    status: InstructionSnapshot['status'],
    reason: string | undefined,
    rejections: readonly RejectedDirective[],
    truncated = false,
  ): InstructionSnapshot {
    const digest = sha256Hex(
      canonicalize({
        repositoryId: operation.repositoryId,
        headSha: operation.headSha,
        policyVersionId: operation.policyVersionId,
        workflowDefinitionVersion: operation.workflowDefinitionVersion,
        segments: segments.map((s) =>
          sha256Hex(
            canonicalize({
              tier: s.tier,
              sourceId: s.sourceId,
              category: s.category,
              text: s.text,
              applicablePaths: s.applicablePaths ?? [],
            }),
          ),
        ),
        conflicts,
        truncation: { truncated, reason },
        rejected: (rejected.length > 0 ? rejected : rejections).map((r) => r.reasonCode),
      }),
    );
    return {
      id: randomUUID(),
      repositoryId: operation.repositoryId,
      workflowRunId: operation.workflowRunId,
      headSha: operation.headSha,
      workflowDefinitionVersion: operation.workflowDefinitionVersion,
      policyVersionId: operation.policyVersionId,
      taskRequestRef: operation.taskRequestRef,
      schemaVersion: 1,
      status,
      createdAtIso: this.#clock.nowIso(),
      segments,
      rejectedDirectives: rejected,
      conflicts,
      truncation: { truncated, ...(reason !== undefined ? { reason } : {}) },
      digest,
      operationKey: operation.operationKey,
    };
  }

  async #emitEvent(
    type: EmittedReadEvent['type'],
    aggregateId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    // Event emission is best-effort domain signaling (shared.ts): a sink
    // failure must never reject assemble() after a snapshot was already saved.
    try {
      await this.#emit.emit({ type, aggregateId, payload });
    } catch {
      /* non-blocking; never surfaces as an assembly failure */
    }
  }
}

/** Neutralize control characters so stored segments are safe at rest. */
function sanitizeLine(text: string): string {
  return Array.from(text.normalize('NFKC'))
    .map((ch) => (ch < '\u0020' || ch === '\u007f' ? ' ' : ch))
    .join('');
}

function governingTier(category: DirectiveCategory, fallback: InstructionTier): InstructionTier {
  switch (category) {
    case 'safety':
    case 'global':
      return 'global_safety';
    case 'secret':
    case 'tool':
    case 'approval':
    case 'network':
    case 'sandbox':
      return 'repository_policy';
    case 'validation':
    case 'action_risk':
      return 'workflow_rule';
    default:
      return fallback;
  }
}

function segmentApplies(segment: InstructionSegment, path: string): boolean {
  if (segment.applicablePaths === undefined || segment.applicablePaths.length === 0) {
    return true;
  }
  let any = false;
  for (const scope of segment.applicablePaths) {
    try {
      if (pathMatchesScope(path, scope)) {
        any = true;
        break;
      }
    } catch {
      // Traversal/absolute scope or path: treat as not-applicable (fail closed).
      continue;
    }
  }
  return any;
}

/** Default no-op event sink until the composition root wires the bus. */
class NoopEventSink implements EventSinkPort {
  async emit(_event: EmittedReadEvent): Promise<void> {}
}
