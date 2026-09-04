import { describe, expect, it } from 'vitest';
import { GithubBranchesCommitsAdapter, type WriteContext } from './github-branches-commits.js';
import { InMemoryMutationOperationStore } from './mutation-operation-store.js';
import { InMemoryMutationProvider } from './provider-port.js';
import { resolveMutationEdge, allMutationPairs, isTerminalMutation } from './fsm.js';
import {
  assertMutationBranch,
  assertWritableTarget,
  buildWorkflowBranchName,
  mutationInputDigest,
  sanitizeCommitMessage,
} from './mutation-identity.js';
import { advanceBranchInputSchema, createCommitInputSchema } from './contracts.js';

const RUN_ID = '9b5d2b1c-1122-4433-a5de-0f0f0f0f0f0f';
const OP1 = 'e1f2a3b4-0000-4000-8000-123456789abc';
const OP2 = 'a1b2c3d4-0000-4000-8000-abcdefabcdef';
const OP3 = 'c3d4e5f6-0000-4000-8000-abcdabcdabcd';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const REPO = { owner: 'octo', repo: 'demo' };
const BRANCH = buildWorkflowBranchName(RUN_ID, OP1);
const BRANCH2 = buildWorkflowBranchName(RUN_ID, OP2);
const BRANCH3 = buildWorkflowBranchName(RUN_ID, OP3);

function writeCtx(operationKey: string, digestPayload: Record<string, unknown>): WriteContext {
  const digest = mutationInputDigest(digestPayload);
  return {
    correlationId: 'corr-1',
    actionId: 'action-1',
    authorized: { decisionId: 'd1', operationKey, actionFingerprint: digest, digest },
  };
}

function setup() {
  const provider = new InMemoryMutationProvider();
  const store = new InMemoryMutationOperationStore();
  const service = new GithubBranchesCommitsAdapter({
    provider,
    store,
    clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
  });
  const createBranch = service.createBranch.bind(service);
  const createCommit = service.createCommit.bind(service);
  const advanceBranch = service.advanceBranch.bind(service);
  Object.assign(service, {
    createBranch: (
      input: Parameters<GithubBranchesCommitsAdapter['createBranch']>[0],
      ctx?: WriteContext,
    ) =>
      createBranch(input, ctx ?? writeCtx(input.operationKey, { kind: 'create_branch', ...input })),
    createCommit: (
      input: Parameters<GithubBranchesCommitsAdapter['createCommit']>[0],
      ctx?: WriteContext,
    ) => {
      const message = sanitizeCommitMessage(input.message);
      return createCommit(
        input,
        ctx ?? writeCtx(input.operationKey, { kind: 'create_commit', ...input, message }),
      );
    },
    advanceBranch: (
      input: Parameters<GithubBranchesCommitsAdapter['advanceBranch']>[0],
      ctx?: WriteContext,
    ) =>
      advanceBranch(
        input,
        ctx ?? writeCtx(input.operationKey, { kind: 'advance_branch', ...input }),
      ),
  });
  return { provider, store, service };
}

describe('C020 branch/commit identity', () => {
  it('builds an owned agent-namespace branch and rejects unsafe targets', () => {
    const name = buildWorkflowBranchName(RUN_ID, OP1);
    expect(name.startsWith('agent/')).toBe(true);
    expect(() => assertMutationBranch('main')).toThrow();
    expect(() => assertMutationBranch('feature/x')).toThrow();
    expect(() => assertWritableTarget('main')).toThrow();
    expect(() => assertWritableTarget('master')).toThrow();
    expect(() => assertWritableTarget('refs/heads/master')).toThrow();
    expect(() => assertWritableTarget('agent/run/abc')).not.toThrow();
  });

  it('sanitizes commit messages and rejects secrets/empties', () => {
    expect(sanitizeCommitMessage('  fix   bug\n\n nicely ')).toContain('fix');
    expect(() => sanitizeCommitMessage('   ')).toThrow();
    expect(() => sanitizeCommitMessage('token = abc123def456ghi')).toThrow();
  });
});

describe('C020 mutation FSM', () => {
  it('follows authorized->executing->applied and unknown->reconciling->applied', () => {
    expect(resolveMutationEdge('authorized', 'begin').allowed).toBe(true);
    expect(resolveMutationEdge('executing', 'applied').allowed).toBe(true);
    expect(resolveMutationEdge('executing', 'unknown').allowed).toBe(true);
    expect(resolveMutationEdge('outcome_unknown', 'begin_reconcile').allowed).toBe(true);
    expect(resolveMutationEdge('reconciling', 'reconciled_applied').allowed).toBe(true);
    expect(resolveMutationEdge('reconciling', 'reconciled_not_applied').allowed).toBe(true);
    expect(resolveMutationEdge('reconciling', 'reconciled_conflicted').allowed).toBe(true);
    expect(resolveMutationEdge('outcome_unknown', 'retry').allowed).toBe(false); // must reconcile first
  });

  it('is exhaustive and deterministic over all status x trigger pairs', () => {
    const pairs = allMutationPairs();
    for (const p of pairs) {
      const v = resolveMutationEdge(p.from, p.trigger);
      expect('allowed' in v).toBe(true);
      if (v.allowed) expect(v.to).toBeDefined();
    }
  });

  it('tracks terminals', () => {
    expect(isTerminalMutation('applied')).toBe(true);
    expect(isTerminalMutation('manual_review')).toBe(true);
    expect(isTerminalMutation('executing')).toBe(false);
  });
});

describe('C020 createBranch', () => {
  it('applies and then replays idempotently for the same operation', async () => {
    const { provider, service } = setup();
    const input = {
      repository: REPO,
      branch: BRANCH,
      baseSha: SHA_A,
      workflowRunId: RUN_ID,
      operationKey: OP1,
    };
    const first = await service.createBranch(input);
    expect(first.status).toBe('applied');
    if (first.status !== 'applied') return;
    expect(first.value.headSha).toBe(SHA_A);
    const second = await service.createBranch(input);
    expect(second.status).toBe('replayed');
    expect(provider.calls.filter((c) => c === 'createRef').length).toBe(1);
  });

  it('conflicts when the branch already exists at a different base', async () => {
    const { provider, service } = setup();
    provider.seedBranch(REPO, BRANCH, SHA_B);
    const result = await service.createBranch({
      repository: REPO,
      branch: BRANCH,
      baseSha: SHA_A,
      workflowRunId: RUN_ID,
      operationKey: OP1,
    });
    expect(result.status).toBe('conflict');
  });

  it('reports outcome_unknown on provider timeout instead of blind failure', async () => {
    const { provider, service } = setup();
    provider.failNext = { op: 'createRef', code: 'TIMEOUT' };
    const result = await service.createBranch({
      repository: REPO,
      branch: BRANCH,
      baseSha: SHA_A,
      workflowRunId: RUN_ID,
      operationKey: OP1,
    });
    expect(result.status).toBe('outcome_unknown');
  });

  it('rejects protected targets and non-mutation branches', async () => {
    const { service } = setup();
    await expect(
      service.createBranch({
        repository: REPO,
        branch: 'main',
        baseSha: SHA_A,
        workflowRunId: RUN_ID,
        operationKey: OP1,
      }),
    ).rejects.toThrow();
    await expect(
      service.createBranch({
        repository: REPO,
        branch: 'feature/x',
        baseSha: SHA_A,
        workflowRunId: RUN_ID,
        operationKey: OP1,
      }),
    ).rejects.toThrow();
  });

  it('declines a write without prior authorization', async () => {
    const { service } = setup();
    await expect(
      service.createBranch(
        {
          repository: REPO,
          branch: BRANCH,
          baseSha: SHA_A,
          workflowRunId: RUN_ID,
          operationKey: OP1,
        },
        {
          correlationId: 'corr-1',
          actionId: 'action-1',
          authorized: {
            decisionId: 'd1',
            operationKey: OP1,
            actionFingerprint: '',
            digest: '',
          },
        },
      ),
    ).rejects.toThrow();
  });

  it('rejects opKey reuse with different inputs (digest conflict)', async () => {
    const { service } = setup();
    await service.createBranch({
      repository: REPO,
      branch: BRANCH,
      baseSha: SHA_A,
      workflowRunId: RUN_ID,
      operationKey: OP1,
    });
    const result = await service.createBranch({
      repository: REPO,
      branch: BRANCH,
      baseSha: SHA_B,
      workflowRunId: RUN_ID,
      operationKey: OP1,
    });
    expect(result.status).toBe('conflict');
  });

  it('rejects a branch not bound to its workflow run and operation', async () => {
    const { service } = setup();
    // Same namespace, but the canonical branch for a DIFFERENT operation key.
    const unbound = buildWorkflowBranchName(RUN_ID, OP2);
    await expect(
      service.createBranch({
        repository: REPO,
        branch: unbound,
        baseSha: SHA_A,
        workflowRunId: RUN_ID,
        operationKey: OP1,
      }),
    ).rejects.toThrow('GITHUB_MUTATION_BRANCH_UNBOUND');
  });

  it('does not claim an applied replay for an uncertain prior attempt', async () => {
    const { provider, service } = setup();
    provider.failNext = { op: 'createRef', code: 'TIMEOUT' };
    const first = await service.createBranch({
      repository: REPO,
      branch: BRANCH2,
      baseSha: SHA_A,
      workflowRunId: RUN_ID,
      operationKey: OP2,
    });
    expect(first.status).toBe('outcome_unknown');
    // Same key/digest retried while the prior attempt is still uncertain must NOT
    // claim an applied replay — reconciliation must resolve it first.
    const retry = await service.createBranch({
      repository: REPO,
      branch: BRANCH2,
      baseSha: SHA_A,
      workflowRunId: RUN_ID,
      operationKey: OP2,
    });
    expect(retry.status).toBe('outcome_unknown');
  });
});

describe('C020 createCommit + advanceBranch', () => {
  const tree = {
    entries: [
      { path: 'docs/x.md', mode: '100644' as const, type: 'blob' as const, sha: '0'.repeat(40) },
    ],
  };

  it('creates a commit and advances the owned branch', async () => {
    const { provider, service } = setup();
    provider.seedBranch(REPO, BRANCH, SHA_A);
    const result = await service.createCommit({
      repository: REPO,
      branch: BRANCH,
      expectedHeadSha: SHA_A,
      parentSha: SHA_A,
      tree,
      message: 'feat: add doc',
      workflowRunId: RUN_ID,
      operationKey: OP1,
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.value.message).toContain('add doc');
    // branch advanced
    const branch = await service.getBranch(REPO, BRANCH);
    if ('code' in branch) throw new Error('unexpected getBranch failure');
    expect(branch.headSha).not.toBe(SHA_A);
  });

  it('conflicts when the expected head is no longer current (CAS)', async () => {
    const { provider, service } = setup();
    provider.seedBranch(REPO, BRANCH, SHA_B);
    const result = await service.createCommit({
      repository: REPO,
      branch: BRANCH,
      expectedHeadSha: SHA_A,
      parentSha: SHA_A,
      tree,
      message: 'feat: doc',
      workflowRunId: RUN_ID,
      operationKey: OP1,
    });
    expect(result.status).toBe('conflict');
  });

  it('reports outcome_unknown when the ref advance is uncertain (orphan commit)', async () => {
    const { provider, service } = setup();
    provider.seedBranch(REPO, BRANCH, SHA_A);
    provider.failNext = { op: 'updateRef', code: 'TIMEOUT' };
    const result = await service.createCommit({
      repository: REPO,
      branch: BRANCH,
      expectedHeadSha: SHA_A,
      parentSha: SHA_A,
      tree,
      message: 'feat: doc',
      workflowRunId: RUN_ID,
      operationKey: OP1,
    });
    expect(result.status).toBe('outcome_unknown');
    expect(result.detail).toContain('orphan');
  });

  it('advanceBranch is non-force, exact-state CAS, and reports unknown on timeout', async () => {
    const { provider, service } = setup();
    provider.seedBranch(REPO, BRANCH, SHA_A);
    const ok = await service.advanceBranch({
      repository: REPO,
      branch: BRANCH,
      expectedOldSha: SHA_A,
      newSha: SHA_B,
      force: false,
      workflowRunId: RUN_ID,
      operationKey: OP1,
    });
    expect(ok.status).toBe('applied');
    // A distinct owned branch exercises the timeout path without an ownership clash.
    provider.seedBranch(REPO, BRANCH2, SHA_A);
    provider.failNext = { op: 'updateRef', code: 'SERVER_ERROR' };
    const unknown = await service.advanceBranch({
      repository: REPO,
      branch: BRANCH2,
      expectedOldSha: SHA_A,
      newSha: SHA_C,
      force: false,
      workflowRunId: RUN_ID,
      operationKey: OP2,
    });
    expect(unknown.status).toBe('outcome_unknown');
  });

  it('force=true is rejected at the schema boundary', () => {
    expect(() =>
      advanceBranchInputSchema.parse({
        repository: REPO,
        branch: BRANCH,
        expectedOldSha: SHA_A,
        newSha: SHA_B,
        force: true,
        workflowRunId: RUN_ID,
        operationKey: OP1,
      }),
    ).toThrow();
  });

  it('schema rejects invalid create-commit trees', () => {
    expect(() =>
      createCommitInputSchema.parse({
        repository: REPO,
        branch: BRANCH,
        expectedHeadSha: SHA_A,
        parentSha: SHA_A,
        tree: { entries: [{ path: '../escape', mode: '100644', type: 'blob', sha: SHA_A }] },
        message: 'x',
        workflowRunId: RUN_ID,
        operationKey: OP1,
      }),
    ).toThrow();
  });
});

describe('C020 reconcile', () => {
  it('reconciles an uncertain createBranch to applied when the ref now points at the base', async () => {
    const { service, provider } = setup();
    provider.failNext = { op: 'createRef', code: 'TIMEOUT' };
    const result = await service.createBranch({
      repository: REPO,
      branch: BRANCH,
      baseSha: SHA_A,
      workflowRunId: RUN_ID,
      operationKey: OP1,
    });
    expect(result.status).toBe('outcome_unknown');
    if (result.status !== 'outcome_unknown') return;
    // Provider actually applied it (response lost); reconcile against real state.
    provider.seedBranch(REPO, BRANCH, SHA_A);
    const op = await service.operationStore().findByIdempotency(OP1);
    if (op === undefined) throw new Error('op missing');
    const reconciled = await service.reconcile({ operationId: op.id });
    expect(reconciled.state).toBe('applied');
  });

  it('reconciles an uncertain createBranch to not_applied when the ref was never created', async () => {
    const { service, provider } = setup();
    provider.failNext = { op: 'createRef', code: 'TIMEOUT' };
    await service.createBranch({
      repository: REPO,
      branch: BRANCH2,
      baseSha: SHA_A,
      workflowRunId: RUN_ID,
      operationKey: OP2,
    });
    const op = await service.operationStore().findByIdempotency(OP2);
    if (op === undefined) throw new Error('op missing');
    const reconciled = await service.reconcile({ operationId: op.id });
    expect(reconciled.state).toBe('not_applied');
  });

  it('reconciles not-found operations as failed safely', async () => {
    const { service } = setup();
    const result = await service.reconcile({ operationId: 'does-not-exist' });
    expect(result.state).toBe('failed');
  });

  it('escalates to manual_review when the reconcile read itself fails', async () => {
    const { provider, service } = setup();
    provider.failNext = { op: 'createRef', code: 'TIMEOUT' };
    await service.createBranch({
      repository: REPO,
      branch: BRANCH3,
      baseSha: SHA_A,
      workflowRunId: RUN_ID,
      operationKey: OP3,
    });
    const op = await service.operationStore().findByIdempotency(OP3);
    if (op === undefined) throw new Error('op missing');
    // Reconcile cannot read the provider: absence is NOT authoritative, so the
    // possibly-applied write must not be classified as not_applied/conflicted.
    provider.failNext = { op: 'branchState', code: 'TIMEOUT' };
    const reconciled = await service.reconcile({ operationId: op.id });
    expect(reconciled.state).toBe('manual_review');
  });
});

describe('CP010 — boolean authorization is gone', () => {
  it('compile-time: a boolean `authorization` is rejected for a write context', () => {
    // @ts-expect-error — writes require a verified AuthorizedActionContext, never a boolean
    const forbidden: WriteContext = { correlationId: 'c', actionId: 'a', authorization: true };
    void forbidden;
  });
});
