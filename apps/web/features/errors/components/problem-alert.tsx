'use client';

import type { ReactNode } from 'react';
import { DevGuardApiError, isDevGuardApiError } from '@/lib/api/errors';
import { Button } from '@/components/ui/primitives';

export interface UiProblem {
  readonly title: string;
  readonly body: string;
  readonly requestId?: string;
  readonly recovery: 'retry' | 'sign-in' | 'none' | 'reconcile';
  readonly code?: string;
}

export function classifyUiProblem(error: unknown): UiProblem {
  if (isDevGuardApiError(error) || error instanceof DevGuardApiError) {
    if (error.isUnauthenticated) {
      return {
        title: 'Sign in required',
        body: 'Your session ended. Sign in again to continue.',
        requestId: error.requestId,
        recovery: 'sign-in',
        code: error.code,
      };
    }
    if (error.isForbidden) {
      if (
        error.code === 'MISSING_PERMISSIONS' ||
        error.code === 'INSTALLATION_INACTIVE' ||
        error.code === 'VALIDATION_FAILED'
      ) {
        return {
          title: 'Could not connect repository',
          body: error.message,
          requestId: error.requestId,
          recovery: 'none',
          code: error.code,
        };
      }
      return {
        title: 'Not available',
        body: 'You do not have access to this resource, or it does not exist.',
        requestId: error.requestId,
        recovery: 'none',
        code: error.code,
      };
    }
    if (error.mutationOutcomeUnknown) {
      return {
        title: 'Checking whether the action completed',
        body: 'The request may have reached the server. Refresh this page before sending it again.',
        requestId: error.requestId,
        recovery: 'reconcile',
        code: error.code,
      };
    }
    if (error.status === 429) {
      return {
        title: 'Slow down',
        body: 'The server is rate-limiting requests. Wait a moment, then retry.',
        requestId: error.requestId,
        recovery: 'retry',
        code: error.code,
      };
    }
    return {
      title: 'Something went wrong',
      body: error.message,
      requestId: error.requestId,
      recovery: error.retryable ? 'retry' : 'none',
      code: error.code,
    };
  }
  return {
    title: 'Something went wrong',
    body: 'An unexpected error occurred.',
    recovery: 'retry',
  };
}

export function ProblemAlert({
  problem,
  onRecover,
}: {
  readonly problem: UiProblem;
  readonly onRecover?: () => void;
}): ReactNode {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-lg)] border border-[var(--danger)]/30 bg-[var(--danger-soft)] p-4"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--danger)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[var(--ink)]">{problem.title}</p>
          <p className="mt-1 text-[var(--muted)]">{problem.body}</p>
          {problem.requestId !== undefined ? (
            <p className="mt-2 font-mono text-xs break-all text-[var(--muted)]">
              Request ID: {problem.requestId}
            </p>
          ) : null}
          {onRecover !== undefined &&
          (problem.recovery === 'retry' || problem.recovery === 'reconcile') ? (
            <div className="mt-3">
              <Button tone="neutral" onClick={onRecover}>
                {problem.recovery === 'reconcile' ? 'Refresh status' : 'Retry'}
              </Button>
            </div>
          ) : null}
          {problem.recovery === 'sign-in' ? (
            <div className="mt-3">
              <Button href="/sign-in">Sign in</Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
