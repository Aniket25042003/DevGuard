import { describe, expect, it } from 'vitest';
import {
  GitHubPullRequestsReviewsChecksAdapter,
  type PrWriteContext,
} from './github-pull-requests.js';
import { InMemoryPrOperationStore } from './operation-store.js';
import { InMemoryPrProvider } from './provider-port.js';
import { resolvePrMergeEdge, resolvePrMutationEdge } from './fsm.js';
import { sanitizePrContent } from './pr-safe.js';
import type { MergePullRequest, PullRequest } from './contracts.js';

const OP1 = 'e1f2a3b4-0000-4000-8000-123456789abc';
const OP2 = 'a1b2c3d4-0000-4000-8000-abcdefabcdef';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const RUN = '9b5d2b1c-1122-4433-a5de-0f0f0f0f0f0f';
const REPO = { owner: 'octo', repo: 'demo' };
const REF = { owner: 'octo', repo: 'demo', number: 1 };

function ctx(): PrWriteContext {
  return { correlationId: 'corr', actionId: 'action-1', authorization: true };
}
function ctx2(): PrWriteContext {
  return { correlationId: 'corr2', actionId: 'action-2', authorization: true };
}

function seedPr(provider: InMemoryPrProvider, overrides?: Partial<PullRequest>): PullRequest {
  const pr: PullRequest = {
    providerId: 'pr-1',
    ref: REF,
    number: 1,
    title: 'feat',
    body: 'hello',
    state: 'open_ready',
    draft: false,
    baseRef: 'main',
    headRef: 'agent/x/1',
    baseSha: SHA_A,
    headSha: SHA_B,
    authorLogin: 'devguard',
    mergeable: 'mergeable',
    updatedAtIso: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
  provider.seedPr(pr);
  return pr;
}

function setup() {
  const provider = new InMemoryPrProvider();
  const store = new InMemoryPrOperationStore();
  const service = new GitHubPullRequestsReviewsChecksAdapter({
    provider,
    store,
    clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
  });
  return { provider, store, service };
}

function mergeInput(existing: PullRequest): MergePullRequest {
  return {
    repository: REPO,
    prNumber: existing.number,
    expectedHeadSha: existing.headSha,
    expectedBaseSha: existing.baseSha,
    approvedFingerprint: {
      prNumber: existing.number,
      baseSha: existing.baseSha,
      headSha: existing.headSha,
      state: 'open_ready',
      draft: false,
      mergeable: 'mergeable',
      requiredEvidenceDigests: ['v1'],
      policyVersionId: 'p1',
      capturedAtIso: '2026-08-28T00:00:00.000Z',
    },
    approvalId: 'a1b2c3d4-0000-4000-8000-000000000099',
    actionId: 'action-merge',
    validationDigest: 'digest-v1',
    method: 'squash',
    workflowRunId: RUN,
    operationKey: OP2,
  };
}

describe('C021 PR/merge FSM', () => {
  it('merge follows approved->revalidate->execute->verify->applied', () => {
    expect(resolvePrMergeEdge('approved', 'revalidate').allowed).toBe(true);
    expect(resolvePrMergeEdge('revalidating', 'execute').allowed).toBe(true);
    expect(resolvePrMergeEdge('executing', 'verify').allowed).toBe(true);
    expect(resolvePrMergeEdge('verifying', 'applied').allowed).toBe(true);
  });

  it('merge stales on drift and blocks on explicit conflict', () => {
    expect(resolvePrMergeEdge('approved', 'stale').allowed).toBe(true);
    expect(resolvePrMergeEdge('revalidating', 'stale').allowed).toBe(true);
    expect(resolvePrMergeEdge('verifying', 'blocked').allowed).toBe(true);
    expect(resolvePrMergeEdge('approved', 'applied').allowed).toBe(false);
  });

  it('general mutation FSM is exhaustive', () => {
    expect(resolvePrMutationEdge('authorized', 'begin').allowed).toBe(true);
    expect(resolvePrMutationEdge('executing', 'unknown').allowed).toBe(true);
    expect(resolvePrMutationEdge('outcome_unknown', 'begin_reconcile').allowed).toBe(true);
  });
});

describe('C021 PR content safety', () => {
  it('sanitizes and rejects secrets in PR/comment body', () => {
    expect(sanitizePrContent('  hello  world  ')).toBe('hello world');
    expect(() => sanitizePrContent('token = abc123def456ghi')).toThrow();
    expect(() => sanitizePrContent('   ')).toThrow();
  });
});

describe('C021 PR adapter', () => {
  it('creates a PR and replays idempotently for the same operation', async () => {
    const { provider, service } = setup();
    void provider;
    const input = {
      repository: REPO,
      ownedHeadBranch: 'agent/x/1',
      headSha: SHA_B,
      baseBranch: 'main',
      baseSha: SHA_A,
      title: 'feat: doc',
      body: 'adds docs',
      draft: false,
      workflowRunId: RUN,
      operationKey: OP1,
    };
    const first = await service.createPullRequest(input, ctx());
    expect(first.status).toBe('applied');
    if (first.status !== 'applied') return;
    expect(first.value.headRef).toBe('agent/x/1');
    const second = await service.createPullRequest(input, ctx());
    expect(second.status).toBe('replayed');
  });

  it('returns a normalized PR via read', async () => {
    const { provider, service } = setup();
    seedPr(provider);
    const pr = await service.getPullRequest(REF, { correlationId: 'c' });
    expect('providerId' in pr).toBe(true);
    if ('providerId' in pr) expect(pr.state).toBe('open_ready');
  });

  it('posts a comment and rejects opKey reuse with different inputs', async () => {
    const { service } = setup();
    const input = {
      repository: REPO,
      prNumber: 1,
      body: 'looks good',
      workflowRunId: RUN,
      operationKey: OP1,
    };
    const first = await service.postPullRequestComment(input, ctx());
    expect(first.status).toBe('applied');
    const dup = await service.postPullRequestComment({ ...input, body: 'different text' }, ctx());
    expect(dup.status).toBe('conflict');
  });

  it('merges an approved PR when current state matches the approved fingerprint', async () => {
    const { provider, service } = setup();
    const pr = seedPr(provider);
    const result = await service.mergePullRequest(mergeInput(pr), ctx2());
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.value.mergeSha).toBeDefined();
  });

  it('marks merge stale when the head moved after approval (never executes)', async () => {
    const { provider, service } = setup();
    seedPr(provider); // head SHA_B
    const result = await service.mergePullRequest(
      {
        ...mergeInput({
          ...{
            providerId: 'pr-1',
            ref: REF,
            number: 1,
            title: '',
            body: '',
            state: 'open_ready',
            draft: false,
            baseRef: 'main',
            headRef: 'agent/x/1',
            baseSha: SHA_A,
            headSha: SHA_B,
            authorLogin: 'd',
            mergeable: 'mergeable',
            updatedAtIso: 'x',
          },
        }),
        expectedHeadSha: 'c'.repeat(40),
      },
      ctx2(),
    );
    expect(result.status).toBe('stale');
  });

  it('blocks an approved merge when the PR is conflicting', async () => {
    const { provider, service } = setup();
    const pr = seedPr(provider, { mergeable: 'conflicting' });
    const result = await service.mergePullRequest(mergeInput(pr), ctx2());
    expect(result.status).toBe('blocked');
  });

  it('refuses an unauthenticated write', async () => {
    const { service } = setup();
    await expect(
      service.postPullRequestComment(
        { repository: REPO, prNumber: 1, body: 'x', workflowRunId: RUN, operationKey: OP1 },
        { ...ctx(), authorization: false },
      ),
    ).rejects.toThrow();
  });
});
