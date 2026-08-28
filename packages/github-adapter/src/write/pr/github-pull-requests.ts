/**
 * C021 §10/§12 — GitHub Pull Requests, Reviews, Checks adapter service.
 *
 * Reads normalize provider evidence into unknown-safe, provenance-labelled
 * models (GitHub remains authoritative; Qodo has no runtime adapter and is
 * never fabricated). Writes are idempotent by operation key + canonical input
 * digest, preflight current state, replay semantic duplicates, and reconcile
 * uncertain outcomes. Merge runs only through a fresh revalidation of
 * head/base/state against the approved fingerprint (C031–C035); any drift yields
 * stale/blocked, never execution, and the result is verified afterward.
 */
import { randomUUID } from 'node:crypto';
import { makeError } from '@devguard/errors';
import {
  createPullRequestSchema,
  mergePullRequestSchema,
  postCommentSchema,
  prRefSchema,
  requestReviewSchema,
  updatePullRequestSchema,
  type CreatePullRequest,
  type MergePullRequest,
  type PostPullRequestComment,
  type PrRef,
  type PullRequest,
  type RequestReview,
  type ReviewEvidence,
  type UpdatePullRequest,
} from './contracts.js';
import { resolvePrMergeEdge } from './fsm.js';
import type { PrOperationStorePort, PrOperation } from './operation-store.js';
import type { PrProviderPort } from './provider-port.js';
import { mutationInputDigest, sanitizePrContent } from './pr-safe.js';
import type { AuthorizedActionContext } from '../../core/contracts.js';

export interface PrReadContext {
  readonly correlationId: string;
}
export interface PrWriteContext extends PrReadContext {
  readonly actionId: string;
  /** Verified C030 authorized-action context — boolean authorization is GONE. */
  readonly authorized: AuthorizedActionContext;
}

export type PrMutationResult<T> =
  | { readonly status: 'applied'; readonly value: T; readonly operationId: string }
  | {
      readonly status: 'replayed';
      readonly value?: T | undefined;
      readonly detail: string;
      readonly operationId: string;
    }
  | { readonly status: 'conflict'; readonly detail: string; readonly operationId: string }
  | { readonly status: 'stale'; readonly detail: string; readonly operationId: string }
  | { readonly status: 'blocked'; readonly detail: string; readonly operationId: string }
  | { readonly status: 'outcome_unknown'; readonly detail: string; readonly operationId: string }
  | { readonly status: 'failed'; readonly detail: string; readonly operationId: string };

export interface MergeResult {
  readonly prNumber: number;
  readonly mergeSha?: string | undefined;
  readonly mergedAtIso?: string | undefined;
}

export interface ReconciliationResult {
  readonly operationId: string;
  readonly state: string;
  readonly detail: string;
}

export interface PrEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly operationId: string;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}
export interface PrEventSinkPort {
  emit(event: PrEvent): Promise<void>;
}

export interface GitHubPullRequestsReviewsChecksDeps {
  readonly provider: PrProviderPort;
  readonly store: PrOperationStorePort;
  readonly clock?: { readonly nowIso: () => string };
  readonly emit?: PrEventSinkPort;
}

export interface GitHubPullRequestsReviewsChecks {
  getPullRequest(
    ref: PrRef,
    ctx: PrReadContext,
  ): Promise<PullRequest | { readonly code: string; readonly detail: string }>;
  listReviewEvidence(
    ref: PrRef,
    kinds: readonly string[],
    limit: number,
    ctx: PrReadContext,
  ): Promise<ReviewEvidence[]>;
  createPullRequest(
    input: CreatePullRequest,
    ctx: PrWriteContext,
  ): Promise<PrMutationResult<PullRequest>>;
  updatePullRequest(
    input: UpdatePullRequest,
    ctx: PrWriteContext,
  ): Promise<PrMutationResult<PullRequest>>;
  postPullRequestComment(
    input: PostPullRequestComment,
    ctx: PrWriteContext,
  ): Promise<PrMutationResult<{ providerId: string }>>;
  requestReview(input: RequestReview, ctx: PrWriteContext): Promise<PrMutationResult<void>>;
  mergePullRequest(
    input: MergePullRequest,
    ctx: PrWriteContext,
  ): Promise<PrMutationResult<MergeResult>>;
  reconcile(input: { operationId: string }): Promise<ReconciliationResult>;
}

export class GitHubPullRequestsReviewsChecksAdapter implements GitHubPullRequestsReviewsChecks {
  readonly #provider: PrProviderPort;
  readonly #store: PrOperationStorePort;
  readonly #clock: { readonly nowIso: () => string };
  readonly #emit: PrEventSinkPort;

  constructor(deps: GitHubPullRequestsReviewsChecksDeps) {
    this.#provider = deps.provider;
    this.#store = deps.store;
    this.#clock = deps.clock ?? { nowIso: () => new Date().toISOString() };
    this.#emit = deps.emit ?? { emit: async () => undefined };
  }

  operationStore(): PrOperationStorePort {
    return this.#store;
  }

  async getPullRequest(
    ref: PrRef,
    ctx: PrReadContext,
  ): Promise<PullRequest | { readonly code: string; readonly detail: string }> {
    void ctx;
    const parsed = prRefSchema.safeParse(ref);
    if (!parsed.success) return { code: 'VALIDATION_FAILED', detail: 'bad PR ref' };
    const result = await this.#provider.getPullRequest(parsed.data);
    return result.ok ? result.value : { code: result.code, detail: result.detail };
  }

  async listReviewEvidence(
    ref: PrRef,
    kinds: readonly string[],
    limit: number,
    ctx: PrReadContext,
  ): Promise<ReviewEvidence[]> {
    void ctx;
    const result = await this.#provider.listEvidence(ref, kinds, limit);
    return result.ok ? [...result.value] : [];
  }

  async createPullRequest(
    input: CreatePullRequest,
    ctx: PrWriteContext,
  ): Promise<PrMutationResult<PullRequest>> {
    const parsed = createPullRequestSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'CREATE_PR_INPUT' } });
    const req = parsed.data;
    const body = sanitizePrContent(req.body);
    const digest = mutationInputDigest({ kind: 'pr_create', ...req, body });
    const op = this.#op('pr_create', req.operationKey, digest, req.workflowRunId);
      authorize(ctx, req.operationKey, digest);
    const claimed = await this.#store.claim(op);
    if (!claimed.ok) return fail('conflict', claimed.detail, op.id);
    if (claimed.replayed) return replayStatus(claimed.operation);

    const created = await this.#provider.createPullRequest({ ...req, body });
    if (created.ok) {
      await this.#record(claimed.operation, 'applied', [created.value.providerId]);
      await this.#event('pull_request.created', op, {
        repo: req.repository,
        pr: created.value.number,
      });
      return { status: 'applied', value: created.value, operationId: op.id };
    }
    if (created.code === 'CONFLICT') {
      await this.#persist(claimed.operation, 'conflicted');
      return fail('conflict', created.detail, op.id);
    }
    await this.#persist(claimed.operation, 'outcome_unknown');
    return { status: 'outcome_unknown', detail: `create ${created.code}`, operationId: op.id };
  }

  async updatePullRequest(
    input: UpdatePullRequest,
    ctx: PrWriteContext,
  ): Promise<PrMutationResult<PullRequest>> {
    const parsed = updatePullRequestSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'UPDATE_PR_INPUT' } });
    const req = parsed.data;
    const patch = {
      ...req.patch,
      ...(req.patch.title !== undefined ? { title: sanitizePrContent(req.patch.title, 200) } : {}),
      ...(req.patch.body !== undefined ? { body: sanitizePrContent(req.patch.body) } : {}),
    };
    const digest = mutationInputDigest({ kind: 'pr_update', ...req, patch });
    const op = this.#op('pr_update', req.operationKey, digest, req.workflowRunId);
      authorize(ctx, req.operationKey, digest);
    const claimed = await this.#store.claim(op);
    if (!claimed.ok) return fail('conflict', claimed.detail, op.id);
    if (claimed.replayed) return replayStatus(claimed.operation);

    const updated = await this.#provider.updatePullRequest({ ...req, patch });
    if (updated.ok) {
      await this.#record(claimed.operation, 'applied', [updated.value.providerId]);
      await this.#event('pull_request.updated', op, { repo: req.repository, pr: req.prNumber });
      return { status: 'applied', value: updated.value, operationId: op.id };
    }
    if (updated.code === 'CONFLICT') {
      await this.#persist(claimed.operation, 'conflicted');
      return fail('conflict', 'PR moved', op.id);
    }
    await this.#persist(claimed.operation, 'outcome_unknown');
    return { status: 'outcome_unknown', detail: `update ${updated.code}`, operationId: op.id };
  }

  async postPullRequestComment(
    input: PostPullRequestComment,
    ctx: PrWriteContext,
  ): Promise<PrMutationResult<{ providerId: string }>> {
    const parsed = postCommentSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'POST_COMMENT_INPUT' } });
    const req = parsed.data;
    const body = sanitizePrContent(req.body);
    const digest = mutationInputDigest({
      kind: 'pr_comment',
      repo: req.repository,
      prNumber: req.prNumber,
      body,
    });
    const op = this.#op('pr_comment', req.operationKey, digest, req.workflowRunId);
      authorize(ctx, req.operationKey, digest);
    const claimed = await this.#store.claim(op);
    if (!claimed.ok) return fail('conflict', claimed.detail, op.id);
    if (claimed.replayed) return replayStatus(claimed.operation);

    const posted = await this.#provider.postComment({ ...req, body });
    if (posted.ok) {
      await this.#record(claimed.operation, 'applied', [posted.value.providerId]);
      await this.#event('pull_request.comment.posted', op, {
        repo: req.repository,
        pr: req.prNumber,
      });
      return { status: 'applied', value: posted.value, operationId: op.id };
    }
    if (posted.code === 'CONFLICT') {
      await this.#persist(claimed.operation, 'conflicted');
      return fail('conflict', posedetail(posted.detail), op.id);
    }
    await this.#persist(claimed.operation, 'outcome_unknown');
    return { status: 'outcome_unknown', detail: `comment ${posted.code}`, operationId: op.id };
  }

  async requestReview(input: RequestReview, ctx: PrWriteContext): Promise<PrMutationResult<void>> {
    const parsed = requestReviewSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'REQUEST_REVIEW_INPUT' } });
    const req = parsed.data;
    const digest = mutationInputDigest({ kind: 'pr_request_review', ...req });
    const op = this.#op('pr_request_review', req.operationKey, digest, req.workflowRunId);
      authorize(ctx, req.operationKey, digest);
    const claimed = await this.#store.claim(op);
    if (!claimed.ok) return fail('conflict', claimed.detail, op.id);
    if (claimed.replayed) return replayStatus(claimed.operation);
    const result = await this.#provider.requestReview(req.repository, req.prNumber, req.reviewers);
    if (result.ok) {
      await this.#record(claimed.operation, 'applied', []);
      return { status: 'applied', value: undefined, operationId: op.id };
    }
    await this.#persist(claimed.operation, 'outcome_unknown');
    return {
      status: 'outcome_unknown',
      detail: `requestReview ${result.code}`,
      operationId: op.id,
    };
  }

  async mergePullRequest(
    input: MergePullRequest,
    ctx: PrWriteContext,
  ): Promise<PrMutationResult<MergeResult>> {
    const parsed = mergePullRequestSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'MERGE_PR_INPUT' } });
    const req = parsed.data;
    const digest = mutationInputDigest({ kind: 'pr_merge', ...req });
    const op = this.#op('pr_merge', req.operationKey, digest, req.workflowRunId);
      authorize(ctx, req.operationKey, digest);
    const claimed = await this.#store.claim(op);
    if (!claimed.ok) return fail('conflict', claimed.detail, op.id);
    if (claimed.replayed) return replayStatus(claimed.operation);

    // Revalidate exact current state against the approved fingerprint.
    if (resolvePrMergeEdge('approved', 'revalidate').allowed === false)
      throw new Error('merge FSM broken');
    const prRef: PrRef = {
      owner: req.repository.owner,
      repo: req.repository.repo,
      number: req.prNumber,
    };
    const current = await this.#provider.getPullRequest(prRef);
    if (!current.ok) return fail('blocked', `cannot revalidate PR: ${current.code}`, op.id);
    const fingerprint = req.approvedFingerprint;
    if (
      current.value.headSha !== req.expectedHeadSha ||
      current.value.baseSha !== req.expectedBaseSha ||
      current.value.headSha !== fingerprint.headSha ||
      current.value.baseSha !== fingerprint.baseSha ||
      current.value.number !== fingerprint.prNumber ||
      current.value.state !== fingerprint.state ||
      current.value.draft !== fingerprint.draft ||
      current.value.mergeable !== fingerprint.mergeable ||
      fingerprint.prNumber !== req.prNumber
    ) {
      await this.#record(claimed.operation, 'stale');
      await this.#event('pull_request.merge.blocked', op, {
        repo: req.repository,
        pr: req.prNumber,
        reason: 'stale',
      });
      return { status: 'stale', detail: 'PR moved since approval', operationId: op.id };
    }
    if (current.value.mergeable === 'conflicting') {
      await this.#persist(claimed.operation, 'blocked');
      await this.#event('pull_request.merge.blocked', op, {
        repo: req.repository,
        pr: req.prNumber,
        reason: 'conflict',
      });
      return { status: 'blocked', detail: 'PR is in a conflicting state', operationId: op.id };
    }

    await this.#event('pull_request.merge.started', op, { repo: req.repository, pr: req.prNumber });
    const merged = await this.#provider.mergePullRequest({ ...req });
    if (merged.ok) {
      // Verify the PR actually reached the merged state rather than trusting the
      // provider's acknowledgement alone.
      const verified = await this.#provider.getPullRequest(prRef);
      if (verified.ok && verified.value.state === 'merged') {
        await this.#record(claimed.operation, 'applied', [merged.value.mergeSha]);
        await this.#event('pull_request.merged', op, {
          repo: req.repository,
          pr: req.prNumber,
          mergeSha: merged.value.mergeSha,
        });
        return {
          status: 'applied',
          value: {
            prNumber: req.prNumber,
            mergeSha: merged.value.mergeSha,
            mergedAtIso: verified.value.mergedAtIso ?? this.#clock.nowIso(),
          },
          operationId: op.id,
        };
      }
      // The provider acknowledged but the PR is not yet confirmed merged — the
      // merge may be in flight or the verification read failed. Surface an
      // uncertain outcome so reconciliation can resolve it.
      await this.#persist(claimed.operation, 'outcome_unknown');
      await this.#event('pull_request.merge.started', op, {
        repo: req.repository,
        pr: req.prNumber,
        reason: 'verifying',
      });
      return {
        status: 'outcome_unknown',
        detail: 'merge requested but not confirmed merged',
        operationId: op.id,
      };
    }
    if (merged.code === 'CONFLICT') {
      await this.#persist(claimed.operation, 'stale');
      return fail('stale', merged.detail, op.id);
    }
    await this.#persist(claimed.operation, 'outcome_unknown');
    return { status: 'outcome_unknown', detail: `merge ${merged.code}`, operationId: op.id };
  }

  async reconcile(input: { operationId: string }): Promise<ReconciliationResult> {
    const op = await this.#store.get(input.operationId);
    if (op === undefined)
      return { operationId: input.operationId, state: 'failed', detail: 'operation not found' };
    if (op.state !== 'outcome_unknown')
      return { operationId: op.id, state: op.state, detail: 'no reconciliation needed' };
    // For PR ops, reconciliation requires provider refetch; MVP surfaces the
    // operation for manual/automatic requery with the durable evidence intact.
    await this.#record(
      {
        ...op,
        state: 'reconciling',
        attempts: op.attempts + 1,
        updatedAtIso: this.#clock.nowIso(),
      },
      null,
    );
    return { operationId: op.id, state: 'reconciling', detail: 'reconciliation requested' };
  }

  #op(kind: string, operationKey: string, inputDigest: string, workflowRunId: string): PrOperation {
    return {
      id: randomUUID(),
      kind,
      operationKey,
      inputDigest,
      state: 'authorized',
      attempts: 1,
      workflowRunId,
      createdAtIso: this.#clock.nowIso(),
      updatedAtIso: this.#clock.nowIso(),
      providerRefs: [],
    };
  }

  async #record(
    op: PrOperation,
    state: string | null,
    providerRefs: readonly string[] = [],
  ): Promise<void> {
    await this.#store.record({
      ...op,
      ...(state !== null ? { state } : {}),
      attempts: op.attempts + 1,
      providerRefs: [...op.providerRefs, ...providerRefs],
      updatedAtIso: this.#clock.nowIso(),
    });
  }

  async #event(
    type: string,
    op: { operationKey: string; id: string },
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#emit.emit({ type, aggregateId: op.operationKey, operationId: op.id, payload });
    } catch {
      // Delivery is retried by outbox/reconciliation infrastructure; the
      // durable mutation is already committed and must not surface an error.
    }
  }

  async #persist(op: PrOperation, state: string): Promise<void> {
    await this.#record(op, state);
  }
}

function authorize(ctx: PrWriteContext, operationKey: string, digest: string): void {
  // Fail closed: the C030 context must carry a non-empty decision digest.
  if (!ctx.authorized.digest || ctx.authorized.operationKey !== operationKey || ctx.authorized.actionFingerprint !== digest || ctx.authorized.digest !== digest)
    throw makeError('REPOSITORY_FORBIDDEN', { details: { reasonCode: 'WRITE_NOT_AUTHORIZED' } });
}

/** Re-surface a prior operation's durable outcome instead of replaying it as success. */
function replayStatus(op: PrOperation): PrMutationResult<never> {
  const status =
    op.state === 'applied' || op.state === 'not_applied'
      ? 'replayed'
      : op.state === 'outcome_unknown' || op.state === 'reconciling'
        ? 'outcome_unknown'
        : op.state === 'stale'
          ? 'stale'
          : op.state === 'blocked'
            ? 'blocked'
            : op.state === 'failed'
              ? 'failed'
              : 'conflict';
  const detail =
    status === 'replayed'
      ? 'operation already applied'
      : `prior attempt left operation ${op.state}; not applied`;
  return { status, detail, operationId: op.id } as PrMutationResult<never>;
}

function fail(
  status: 'conflict' | 'stale' | 'blocked',
  detail: string,
  operationId: string,
): PrMutationResult<never> {
  return { status, detail, operationId } as unknown as PrMutationResult<never>;
}

function posedetail(detail: string): string {
  return detail;
}
