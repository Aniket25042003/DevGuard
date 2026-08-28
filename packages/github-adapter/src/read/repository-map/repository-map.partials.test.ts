import { describe, expect, it } from 'vitest';
import { BudgetTracker } from './budget.js';
import { RepositoryMapStateMachine } from './state-machine.js';
import { canonicalizeRepoPath, isBinaryPath, isVendorOrGeneratedPath } from './path-safety.js';
import { scorePath } from './target-ranker.js';
import { taskFingerprint } from './task-fingerprint.js';
import { TreeCollector } from './tree-summary.js';

describe('C015 budget tracker', () => {
  it('charges requests/paths/bytes and reports exhaustion deterministically', () => {
    const now = 1_000_000;
    const budget = new BudgetTracker(
      { maxRequests: 2, maxPaths: 3, maxBytes: 10, deadlineMs: 1000 },
      now,
    );
    expect(budget.chargeRequest()).toBe(true);
    expect(budget.chargeRequest()).toBe(true);
    expect(budget.chargeRequest()).toBe(false);
    expect(budget.isExhausted(now + 1).includes('requests')).toBe(true);

    expect(
      new BudgetTracker(
        { maxRequests: 2, maxPaths: 3, maxBytes: 10, deadlineMs: 1000 },
        now,
      ).chargeBytes(11),
    ).toBe(false);
    expect(
      new BudgetTracker(
        { maxRequests: 2, maxPaths: 3, maxBytes: 10, deadlineMs: 1000 },
        now,
      ).chargeBytes(-1),
    ).toBe(false);
    const bounded = new BudgetTracker(
      { maxRequests: 2, maxPaths: 3, maxBytes: 10, deadlineMs: 1000 },
      now,
    );
    expect(bounded.chargeBytes(6)).toBe(true);
    expect(bounded.chargeBytes(4)).toBe(true);
    expect(bounded.chargeBytes(1)).toBe(false);
    expect(bounded.isExhausted(now + 1).includes('bytes')).toBe(true);
  });

  it('reports deadline exhaustion after the deadline elapses', () => {
    const now = 5_000;
    const budget = new BudgetTracker(
      { maxRequests: 100, maxPaths: 100, maxBytes: 1_000_000, deadlineMs: 100 },
      now,
    );
    expect(budget.isExhausted(now + 50)).toEqual([]);
    expect(budget.isExhausted(now + 101).includes('deadline')).toBe(true);
  });
});

describe('C015 repository map state machine', () => {
  const fsm = new RepositoryMapStateMachine();
  it('accepts queued->collecting->assembling->complete', () => {
    expect(fsm.isTerminal(fsm.transition('queued', { to: 'collecting' }))).toBe(false);
    expect(fsm.isTerminal(fsm.transition('collecting', { to: 'assembling' }))).toBe(false);
    const done = fsm.transition('assembling', { to: 'complete' });
    expect(done).toBe('complete');
    expect(fsm.isTerminal(done)).toBe(true);
  });

  it('marks partial from any live state and never from terminal states', () => {
    expect(fsm.transition('queued', { to: 'partial' })).toBe('partial');
    expect(() => fsm.transition('complete', { to: 'partial' })).toThrow();
    expect(() => fsm.transition('partial', { to: 'collecting' })).toThrow();
  });

  it('allows failed only from live states and superseded from non-terminal survivors', () => {
    expect(fsm.transition('assembling', { to: 'failed' })).toBe('failed');
    expect(() => fsm.transition('failed', { to: 'superseded' })).toThrow();
    expect(fsm.transition('collecting', { to: 'superseded' })).toBe('superseded');
  });
});

describe('C015 path safety', () => {
  it('rejects traversal, absolute paths, NUL, and dot segments', () => {
    expect(() => canonicalizeRepoPath('../x')).toThrow();
    expect(() => canonicalizeRepoPath('/abs')).toThrow();
    expect(() => canonicalizeRepoPath('a/../b')).toThrow();
    expect(() => canonicalizeRepoPath('a\0b')).toThrow();
    expect(() => canonicalizeRepoPath('./a')).toThrow();
    expect(canonicalizeRepoPath('src/index.ts')).toBe('src/index.ts');
  });

  it('filters vendor/generated and binary paths', () => {
    expect(isVendorOrGeneratedPath('node_modules/x/y.js')).toBe(true);
    expect(isVendorOrGeneratedPath('package-lock.json')).toBe(true);
    expect(isVendorOrGeneratedPath('src/app.ts')).toBe(false);
    expect(isBinaryPath('img/photo.png')).toBe(true);
    expect(isBinaryPath('src/doc.md')).toBe(false);
  });
});

describe('C015 target ranking', () => {
  it('scores exact basenames highest and ranks deterministically', () => {
    const exact = scorePath({ path: 'src/auth.ts', terms: ['auth.ts'] });
    const partial = scorePath({ path: 'src/authentication.ts', terms: ['auth'] });
    expect(exact.score).toBeGreaterThan(partial.score);
    const a = scorePath({ path: 'a/b.ts', terms: ['b'] });
    expect(a.score).toBe(scorePath({ path: 'a/b.ts', terms: ['b'] }).score);
    expect(a.reasons.length).toBeGreaterThan(0);
  });
});

describe('C015 task fingerprint', () => {
  it('is deterministic and order-independent over terms', () => {
    const a = taskFingerprint({
      repositoryId: 'r',
      ref: 'refs/heads/main',
      taskKind: 'issue',
      terms: ['x', 'y'],
    });
    const b = taskFingerprint({
      repositoryId: 'r',
      ref: 'refs/heads/main',
      taskKind: 'issue',
      terms: ['y', 'x'],
    });
    expect(a).toBe(b);
    const c = taskFingerprint({
      repositoryId: 'r',
      ref: 'refs/heads/main',
      taskKind: 'issue',
      terms: ['z'],
    });
    expect(a).not.toBe(c);
  });
});

describe('C015 tree summary', () => {
  it('counts files/dirs, ranks top-level dirs and largest files, skips vendor', () => {
    const budget = new BudgetTracker(
      { maxRequests: 10, maxPaths: 1000, maxBytes: 1_000_000, deadlineMs: 60_000 },
      0,
    );
    const result = new TreeCollector().collect(
      [
        { path: 'src/a.ts', kind: 'blob', objectSha: 'a'.repeat(40), size: 100 },
        { path: 'src/b.ts', kind: 'blob', objectSha: 'a'.repeat(40), size: 200 },
        { path: 'test/a.test.ts', kind: 'blob', objectSha: 'a'.repeat(40), size: 50 },
        { path: 'node_modules/x/y.js', kind: 'blob', objectSha: 'a'.repeat(40), size: 999 },
        { path: 'src', kind: 'tree', objectSha: 'a'.repeat(40) },
        { path: 'test', kind: 'tree', objectSha: 'a'.repeat(40) },
      ],
      budget,
      1,
    );
    expect(result.summary.totalFiles).toBe(3);
    expect(result.summary.totalDirs).toBe(2);
    expect(result.summary.largestFiles[0]?.path).toBe('src/b.ts');
    expect(result.summary.vendorFileCount).toBe(1);
  });
});
