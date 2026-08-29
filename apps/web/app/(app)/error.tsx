'use client';

import type { ReactNode } from 'react';
import { ProblemAlert } from '@/features/errors/index';

export default function ErrorView({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): ReactNode {
  return (
    <ProblemAlert
      problem={{
        title: 'This page failed to render',
        body: 'Reload the page. No stack traces or secrets are shown.',
        recovery: 'retry',
        ...(error.digest !== undefined ? { requestId: error.digest } : {}),
      }}
      onRecover={reset}
    />
  );
}
