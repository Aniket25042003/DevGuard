/**
 * C041 §8/§9/§19 — workspace fence and lease fencing.
 *
 * Every provider/job command and every state mutation carries a fence:
 * workspace id + run id + generation + lease token + expiry. A stale worker
 * (wrong generation or token, or expired lease) is fenced out with
 * WORKSPACE_FENCE_REJECTED; missing/malformed fences are rejected before
 * validation even reaches the provider (fail closed).
 */
import { makeError, validationFailed } from '@devguard/errors';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sandboxIdSchemas, type WorkspaceId } from '../ids.js';

export interface WorkspaceFence {
  readonly workspaceId: WorkspaceId;
  readonly runId: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
}

export const workspaceFenceSchema: z.ZodType<WorkspaceFence> = z
  .object({
    workspaceId: sandboxIdSchemas.workspaceId,
    runId: z.string().min(1).max(128),
    generation: z.number().int().nonnegative(),
    leaseToken: z.string().regex(/^[0-9a-f-]{8,64}$/),
    leaseExpiresAtMs: z.number().int().positive(),
  })
  .strict();

/** Validate an untrusted fence (worker message boundary); throws VALIDATION_FAILED. */
export function parseWorkspaceFence(input: unknown): WorkspaceFence {
  const result = workspaceFenceSchema.safeParse(input);
  if (!result.success) {
    throw validationFailed(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'fence',
        constraint: issue.message,
      })),
    );
  }
  return result.data;
}

export function newLeaseToken(): string {
  return randomUUID();
}

export function isLeaseExpired(fence: WorkspaceFence, nowMs: number): boolean {
  return fence.leaseExpiresAtMs <= nowMs;
}

/**
 * Fencing comparison: identity + generation + token must ALL match, and the
 * lease must not have expired. Any mismatch rejects the caller.
 */
export function assertFenceCurrent(
  expected: WorkspaceFence,
  actual: WorkspaceFence,
  nowMs: number,
): void {
  const reason =
    expected.workspaceId !== actual.workspaceId
      ? 'workspace id mismatch'
      : expected.runId !== actual.runId
        ? 'run id mismatch'
        : expected.generation !== actual.generation
          ? 'generation mismatch (stale worker)'
          : expected.leaseToken !== actual.leaseToken
            ? 'lease token mismatch (fenced worker)'
            : isLeaseExpired(actual, nowMs)
              ? 'lease expired'
              : undefined;
  if (reason !== undefined) {
    throw makeError('WORKSPACE_FENCE_REJECTED', { details: { reason } });
  }
}
