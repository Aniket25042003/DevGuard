/**
 * C020 §10/§12 — GitHub branches/commits mutation adapter service.
 *
 * Every mutation: validates the exact-state input, computes a canonical
 * fingerprint, verifies persisted authorization, claims a durable operation
 * (idempotent replay), preflights the exact expected state, executes exactly
 * one provider write, records a definitive or uncertain outcome, and emits a
 * result. `MutationResult` is applied / replayed / conflict / outcome_unknown —
 * an uncertain provider response is reconciled, never blind-retried. `force`
 * is structurally impossible; default/protected branches are denied.
 */
import { randomUUID } from 'node:crypto';
import { makeError } from '@devguard/errors';
import {
  advanceBranchInputSchema,
  createBranchInputSchema,
  createCommitInputSchema,
  type AdvanceBranchInput,
  type CreateBranchInput,
  type CreateCommitInput,
  type GitBranch,
  type GitCommit,
  type GitMutationOperation,
  type GitRepoRef,
  type MutationResult,
} from './contracts.js';
import { resolveMutationEdge, type MutationTrigger } from './fsm.js';
import {
  assertMutationBranch,
  assertWritableTarget,
  buildWorkflowBranchName,
  mutationInputDigest,
  sanitizeCommitMessage,
} from './mutation-identity.js';
import type { MutationOperationStorePort } from './mutation-operation-store.js';
import type { CommitComparison, GitHubMutationProviderPort } from './provider-port.js';
import type { AuthorizedActionContext } from '../core/contracts.js';

export interface WriteContext {
  readonly correlationId: string;
  readonly actionId: string;
  /** Verified C030 authorized-action context — boolean authorization is GONE. */
  readonly authorized: AuthorizedActionContext;
}

export interface MutationEvent {
  readonly type:
    | 'branch.created'
    | 'commit.created'
    | 'commit.pushed'
    | 'github.mutation.reconciling'
    | 'github.mutation.conflicted';
  readonly aggregateId: string;
  readonly operationId: string;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}

export interface MutationEventSinkPort {
  emit(event: MutationEvent): Promise<void>;
}

export interface ReconciliationResult {
  readonly operationId: string;
  readonly state: GitMutationOperation['state'];
  readonly detail: string;
}

export interface GithubBranchesCommitsDeps {
  readonly provider: GitHubMutationProviderPort;
  readonly store: MutationOperationStorePort;
  readonly clock?: { readonly nowIso: () => string };
  readonly emit?: MutationEventSinkPort;
}

export interface GithubBranchesCommits {
  getBranch(repository: GitRepoRef, branch: string): Promise<BranchReadResult>;
  getCommit(repository: GitRepoRef, sha: string): Promise<CommitReadResult>;
  compareCommits(input: {
    repository: GitRepoRef;
    base: string;
    head: string;
    limit: number;
  }): Promise<ComparisonReadResult>;
  createBranch(input: CreateBranchInput, ctx: WriteContext): Promise<MutationResult<GitBranch>>;
  createCommit(input: CreateCommitInput, ctx: WriteContext): Promise<MutationResult<GitCommit>>;
  advanceBranch(input: AdvanceBranchInput, ctx: WriteContext): Promise<MutationResult<GitBranch>>;
  reconcile(input: { operationId: string }): Promise<ReconciliationResult>;
}

type BranchReadResult = GitBranch | { readonly code: string; readonly detail: string };
type CommitReadResult = GitCommit | { readonly code: string; readonly detail: string };
type ComparisonReadResult = CommitComparison | { readonly code: string; readonly detail: string };

const REF_PREFIX = 'refs/heads/';

export class GithubBranchesCommitsAdapter implements GithubBranchesCommits {
  readonly #provider: GitHubMutationProviderPort;
  readonly #store: MutationOperationStorePort;
  readonly #clock: { readonly nowIso: () => string };
  readonly #emit: MutationEventSinkPort;

  constructor(deps: GithubBranchesCommitsDeps) {
    this.#provider = deps.provider;
    this.#store = deps.store;
    this.#clock = deps.clock ?? { nowIso: () => new Date().toISOString() };
    this.#emit = deps.emit ?? { emit: async () => undefined };
  }

  /** Durable operation store (reconciliation queries + test seam). */
  operationStore(): MutationOperationStorePort {
    return this.#store;
  }

  // ---- reads (repository-authorized, usable independently) ------------------

  async getBranch(repository: GitRepoRef, branch: string): Promise<BranchReadResult> {
    const state = await this.#provider.branchState({ repository, branch });
    if (!state.ok) return { code: state.code, detail: state.detail };
    if (!state.value.exists || state.value.headSha === undefined)
      return { code: 'NOT_FOUND', detail: 'branch not found' };
    return {
      name: branch as unknown as GitBranch['name'],
      ref: `${REF_PREFIX}${branch}`,
      headSha: state.value.headSha as unknown as GitBranch['headSha'],
      protected: state.value.protected ?? false,
      repositoryId: repositoryKey(repository),
    };
  }

  async getCommit(repository: GitRepoRef, sha: string): Promise<CommitReadResult> {
    const result = await this.#provider.getCommit({ repository, sha });
    return result.ok ? result.value : { code: result.code, detail: result.detail };
  }

  async compareCommits(input: {
    repository: GitRepoRef;
    base: string;
    head: string;
    limit: number;
  }): Promise<ComparisonReadResult> {
    const result = await this.#provider.compareCommits(input);
    return result.ok ? result.value : { code: result.code, detail: result.detail };
  }

  // ---- mutations ------------------------------------------------------------

  async createBranch(
    input: CreateBranchInput,
    ctx: WriteContext,
  ): Promise<MutationResult<GitBranch>> {
    const parsed = createBranchInputSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'CREATE_BRANCH_INPUT' } });
    const req = parsed.data;
    protect(req.branch, ctx);
    assertBoundBranch(req);

    const digest = mutationInputDigest({ kind: 'create_branch', ...req });
    const op = this.#newOperation(
      'create_branch',
      ctx,
      req.repository,
      req.branch,
      req.workflowRunId,
      req.operationKey,
      digest,
      req.baseSha,
    );
    const claimed = await this.#store.claim(op);
    if (!claimed.ok) return { status: 'conflict', detail: claimed.code };
    if (claimed.replayed) {
      if (claimed.operation.state !== 'applied') {
        // The prior attempt did not confirm the branch was created. Do not
        // claim an applied replay; surface the uncertain/rejected outcome so
        // reconciliation can resolve it before any retry.
        const status =
          claimed.operation.state === 'outcome_unknown' ||
          claimed.operation.state === 'reconciling' ||
          claimed.operation.state === 'executing'
            ? 'outcome_unknown'
            : 'conflict';
        return {
          status,
          detail: 'prior operation not confirmed applied; reconcile required',
        } as MutationResult<GitBranch>;
      }
      return {
        status: 'replayed',
        value: branchOf(req.repository, req.branch, req.baseSha),
        detail: 'operation already applied',
      };
    }

    const state = await this.#provider.branchState({
      repository: req.repository,
      branch: req.branch,
    });
    if (state.ok && state.value.exists) {
      await this.#failOp(op, 'conflicted', `branch already exists at ${state.value.headSha}`);
      return state.value.headSha === req.baseSha
        ? {
            status: 'replayed',
            value: branchOf(req.repository, req.branch, req.baseSha),
            detail: 'branch already at requested base',
          }
        : { status: 'conflict', detail: `branch exists at different base ${state.value.headSha}` };
    }

    const did = await this.#provider.createRef({
      repository: req.repository,
      ref: `${REF_PREFIX}${req.branch}`,
      sha: req.baseSha,
    });
    if (did.ok) {
      await this.#succeedOp(op, 'applied', [did.value.sha]);
      await this.#event('branch.created', op, {
        repository: req.repository,
        branch: req.branch,
        sha: did.value.sha,
      });
      return { status: 'applied', value: branchOf(req.repository, req.branch, req.baseSha) };
    }
    if (did.code === 'CONFLICT') {
      await this.#failOp(op, 'conflicted', 'branch exists (provider conflict)');
      return { status: 'conflict', detail: 'branch already exists' };
    }
    // TIMEOUT / SERVER_ERROR -> uncertain; reconcile before any retry.
    await this.#markUnknown(op, did.detail);
    return { status: 'outcome_unknown', detail: `createRef ${did.code}: ${did.detail}` };
  }

  async createCommit(
    input: CreateCommitInput,
    ctx: WriteContext,
  ): Promise<MutationResult<GitCommit>> {
    const parsed = createCommitInputSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'CREATE_COMMIT_INPUT' } });
    const req = parsed.data;
    protect(req.branch, ctx);
    assertBoundBranch(req);
    const message = sanitizeCommitMessage(req.message);

    const digest = mutationInputDigest({ kind: 'create_commit', ...req, message });
    const op = this.#newOperation(
      'create_commit',
      ctx,
      req.repository,
      req.branch,
      req.workflowRunId,
      req.operationKey,
      digest,
      req.parentSha,
    );
    const claimed = await this.#store.claim(op);
    if (!claimed.ok) return { status: 'conflict', detail: claimed.code };
    if (claimed.replayed && claimed.operation.intendedAfterSha !== undefined) {
      return {
        status: 'replayed',
        detail: 'operation already applied',
      } as MutationResult<GitCommit>;
    }

    const head = await this.#provider.branchState({
      repository: req.repository,
      branch: req.branch,
    });
    if (!head.ok) {
      await this.#markUnknown(op, `branch preflight ${head.code}`);
      return { status: 'outcome_unknown', detail: `branch preflight ${head.code}` };
    }
    if (!head.value.exists || head.value.protected) {
      await this.#failOp(
        op,
        'conflicted',
        head.value.protected ? 'branch is provider-protected' : 'branch does not exist',
      );
      return {
        status: 'conflict',
        detail: head.value.protected ? 'branch is provider-protected' : 'branch does not exist',
      };
    }
    if (head.value.headSha !== req.expectedHeadSha) {
      await this.#failOp(
        op,
        'conflicted',
        `head changed ${head.value.headSha} != ${req.expectedHeadSha}`,
      );
      return { status: 'conflict', detail: 'expected head no longer current' };
    }

    const created = await this.#provider.createCommit({
      repository: req.repository,
      tree: req.tree,
      parents: [req.parentSha],
      message,
      author: req.author,
    });
    if (!created.ok) {
      if (created.code === 'CONFLICT') {
        await this.#failOp(op, 'conflicted', created.detail);
        return { status: 'conflict', detail: created.detail };
      }
      await this.#markUnknown(op, created.detail);
      return { status: 'outcome_unknown', detail: `createCommit ${created.code}` };
    }
    const fetched = await this.#provider.getCommit({
      repository: req.repository,
      sha: created.value.sha,
    });
    if (!fetched.ok) {
      await this.#markUnknown(
        { ...op, intendedAfterSha: created.value.sha },
        `getCommit ${fetched.code}`,
      );
      return {
        status: 'outcome_unknown',
        detail: `commit created but metadata unavailable (${fetched.code})`,
      };
    }
    const committed: GitCommit = fetched.value;
    /* metadata is authoritative */
    /*
      ? fetched.value
      : {
          sha: created.value.sha as unknown as GitCommit['sha'],
          parents: [req.parentSha],
          treeSha: (req.tree.entries[0]?.sha?.slice(0, 40) ??
            '0'.repeat(40)) as unknown as GitCommit['treeSha'],
          author: req.author ?? {
            name: 'devguard',
            email: 'devguard@invalid',
            dateIso: this.#clock.nowIso(),
          },
          committer: req.author ?? {
            name: 'devguard',
            email: 'devguard@invalid',
            dateIso: this.#clock.nowIso(),
          },
          message,
          verification: 'unsigned',
          createdAtIso: this.#clock.nowIso(),
        };
    */
    await this.#succeedOp(op, 'executing', [created.value.sha], created.value.sha);
    await this.#event('commit.created', op, {
      repository: req.repository,
      branch: req.branch,
      sha: created.value.sha,
    });

    // Second effect: advance the owned branch (non-force, exact old SHA).
    const advanced = await this.#provider.updateRef({
      repository: req.repository,
      ref: `${REF_PREFIX}${req.branch}`,
      oldSha: req.expectedHeadSha,
      newSha: created.value.sha,
      force: false,
    });
    if (advanced.ok) {
      await this.#succeedOp(op, 'applied', [created.value.sha, advanced.value.sha]);
      await this.#event('commit.pushed', op, {
        repository: req.repository,
        branch: req.branch,
        sha: advanced.value.sha,
      });
      return { status: 'applied', value: committed };
    }
    if (advanced.code === 'CONFLICT') {
      await this.#failOp(
        op,
        'conflicted',
        `ref advance conflict (orphan commit ${created.value.sha})`,
      );
      return {
        status: 'conflict',
        detail: `ref advanced by another writer; orphan commit ${created.value.sha}`,
      };
    }
    await this.#markUnknown(
      { ...op, intendedAfterSha: created.value.sha },
      `${advanced.code}: ref not confirmed`,
    );
    return {
      status: 'outcome_unknown',
      detail: `commit created but ref not confirmed (orphan commit ${created.value.sha})`,
    };
  }

  async advanceBranch(
    input: AdvanceBranchInput,
    ctx: WriteContext,
  ): Promise<MutationResult<GitBranch>> {
    const parsed = advanceBranchInputSchema.safeParse(input);
    if (!parsed.success)
      throw makeError('VALIDATION_FAILED', { details: { reasonCode: 'ADVANCE_BRANCH_INPUT' } });
    const req = parsed.data;
    protect(req.branch, ctx);
    assertBoundBranch(req);

    const digest = mutationInputDigest({ kind: 'advance_branch', ...req });
    const op = this.#newOperation(
      'advance_branch',
      ctx,
      req.repository,
      req.branch,
      req.workflowRunId,
      req.operationKey,
      digest,
      req.expectedOldSha,
      req.newSha,
    );
    const claimed = await this.#store.claim(op);
    if (!claimed.ok) return { status: 'conflict', detail: claimed.code };
    if (claimed.replayed && claimed.operation.intendedAfterSha !== undefined) {
      return {
        status: 'replayed',
        value: branchOf(req.repository, req.branch, claimed.operation.intendedAfterSha),
      };
    }

    const head = await this.#provider.branchState({
      repository: req.repository,
      branch: req.branch,
    });
    if (!head.ok) {
      await this.#markUnknown(op, `branch preflight ${head.code}`);
      return { status: 'outcome_unknown', detail: `branch preflight ${head.code}` };
    }
    if (!head.value.exists || head.value.protected) {
      await this.#failOp(
        op,
        'conflicted',
        head.value.protected ? 'branch is provider-protected' : 'branch does not exist',
      );
      return {
        status: 'conflict',
        detail: head.value.protected ? 'branch is provider-protected' : 'branch does not exist',
      };
    }
    if (head.value.headSha !== req.expectedOldSha) {
      await this.#failOp(op, 'conflicted', 'expected old SHA no longer current');
      return { status: 'conflict', detail: 'expected old SHA no longer current' };
    }
    const advanced = await this.#provider.updateRef({
      repository: req.repository,
      ref: `${REF_PREFIX}${req.branch}`,
      oldSha: req.expectedOldSha,
      newSha: req.newSha,
      force: false,
    });
    if (advanced.ok) {
      await this.#succeedOp(op, 'applied', [advanced.value.sha]);
      await this.#event('commit.pushed', op, {
        repository: req.repository,
        branch: req.branch,
        sha: advanced.value.sha,
      });
      return { status: 'applied', value: branchOf(req.repository, req.branch, req.newSha) };
    }
    if (advanced.code === 'CONFLICT') {
      await this.#failOp(op, 'conflicted', advanced.detail);
      return { status: 'conflict', detail: advanced.detail };
    }
    await this.#markUnknown(op, advanced.detail);
    return { status: 'outcome_unknown', detail: advanced.detail };
  }

  async reconcile(input: { operationId: string }): Promise<ReconciliationResult> {
    const op = await this.#store.get(input.operationId);
    if (op === undefined)
      return { operationId: input.operationId, state: 'failed', detail: 'operation not found' };
    if (op.state !== 'outcome_unknown' && op.state !== 'executing') {
      return { operationId: op.id, state: op.state, detail: 'no reconciliation needed' };
    }
    // outcome_unknown --begin_reconcile--> reconciling.
    const started = resolveMutationEdge(op.state, 'begin_reconcile');
    if (!started.allowed)
      return { operationId: op.id, state: op.state, detail: 'cannot reconcile from current state' };

    const state = await this.#provider.branchState({
      repository: op.repository,
      branch: op.branch,
    });
    let trigger: MutationTrigger;
    if (state.ok && state.value.exists) {
      if (state.value.headSha === op.intendedAfterSha) trigger = 'reconciled_applied';
      else if (op.kind === 'create_branch' && state.value.headSha === op.expectedBeforeSha)
        trigger = 'reconciled_applied';
      else trigger = 'reconciled_conflicted';
    } else if (state.ok) {
      // Authoritative absence. A confirmed-absent branch is definitive.
      trigger = op.kind === 'create_branch' ? 'reconciled_not_applied' : 'reconciled_conflicted';
    } else {
      // Provider read failed — absence (or presence) is NOT authoritative. Escalate
      // to manual review rather than misclassifying a possibly-applied write as
      // not_applied / conflicted (Qodo #10).
      trigger = 'manual';
    }
    const verdict = resolveMutationEdge('reconciling', trigger);
    const next = verdict.allowed ? verdict.to : 'manual_review';
    const nextOp: GitMutationOperation = { ...op, state: next, updatedAtIso: this.#clock.nowIso() };
    await this.#store.record(nextOp);
    await this.#event(
      trigger === 'reconciled_conflicted'
        ? 'github.mutation.conflicted'
        : 'github.mutation.reconciling',
      nextOp,
      {},
    );
    return { operationId: op.id, state: next, detail: `reconciled via ${trigger}` };
  }

  // ---- internals ------------------------------------------------------------

  #newOperation(
    kind: GitMutationOperation['kind'],
    ctx: WriteContext,
    repository: GitRepoRef,
    branch: string,
    workflowRunId: string,
    operationKey: string,
    inputDigest: string,
    expectedBeforeSha: string,
    intendedAfterSha?: string,
  ): GitMutationOperation {
    return {
      id: randomUUID(),
      kind,
      actionId: ctx.actionId,
      repository,
      branch,
      workflowRunId,
      operationKey,
      inputDigest,
      expectedBeforeSha,
      ...(intendedAfterSha !== undefined ? { intendedAfterSha } : {}),
      state: 'authorized',
      attempts: 1,
      providerRefs: [],
      createdAtIso: this.#clock.nowIso(),
      updatedAtIso: this.#clock.nowIso(),
    };
  }

  async #succeedOp(
    op: GitMutationOperation,
    state: GitMutationOperation['state'],
    providerRefs: readonly string[],
    intendedAfterSha?: string,
  ): Promise<void> {
    const next: GitMutationOperation = {
      ...op,
      state,
      attempts: op.attempts + 1,
      providerRefs: [...op.providerRefs, ...providerRefs],
      ...(intendedAfterSha !== undefined ? { intendedAfterSha } : {}),
      updatedAtIso: this.#clock.nowIso(),
    };
    await this.#store.record(next);
  }

  async #failOp(
    op: GitMutationOperation,
    state: 'conflicted' | 'failed',
    detail: string,
  ): Promise<void> {
    const next: GitMutationOperation = {
      ...op,
      state,
      attempts: op.attempts + 1,
      updatedAtIso: this.#clock.nowIso(),
    };
    await this.#store.record(next);
    await this.#event('github.mutation.conflicted', next, { detail });
  }

  async #markUnknown(op: GitMutationOperation, detail: string): Promise<void> {
    const next: GitMutationOperation = {
      ...op,
      state: 'outcome_unknown',
      attempts: op.attempts + 1,
      updatedAtIso: this.#clock.nowIso(),
    };
    await this.#store.record(next);
    await this.#event('github.mutation.reconciling', next, { detail });
  }

  async #event(
    type: MutationEvent['type'],
    op: GitMutationOperation,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#emit.emit({ type, aggregateId: op.operationKey, operationId: op.id, payload });
    } catch {
      // Delivery is retried by reconciliation/outbox infrastructure; mutation is committed.
    }
  }
}

function protect(branch: string, ctx: WriteContext): void {
  assertMutationBranch(branch);
  assertWritableTarget(branch);
  // Fail closed: the C030 context must carry a non-empty decision digest.
  if (!ctx.authorized.digest)
    throw makeError('REPOSITORY_FORBIDDEN', { details: { reasonCode: 'WRITE_NOT_AUTHORIZED' } });
}

/** A mutation branch must be the canonical branch for THIS workflow run + operation. */
function assertBoundBranch(req: {
  branch: string;
  workflowRunId: string;
  operationKey: string;
}): void {
  if (req.branch !== buildWorkflowBranchName(req.workflowRunId, req.operationKey)) {
    throw new Error('GITHUB_MUTATION_BRANCH_UNBOUND');
  }
}

function repositoryKey(repository: GitRepoRef): string {
  return `${repository.owner}/${repository.repo}`;
}

function branchOf(repository: GitRepoRef, branch: string, headSha: string): GitBranch {
  return {
    name: branch as unknown as GitBranch['name'],
    ref: `${REF_PREFIX}${branch}`,
    headSha: headSha as unknown as GitBranch['headSha'],
    protected: false,
    repositoryId: repositoryKey(repository),
  };
}
