'use client';

import { useQuery } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/server-state/query-keys';
import { PageHeader, StatusBadge } from '@/components/ui/primitives';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';

export function PreflightPage(): ReactNode {
  const client = getApiClient();
  const preflight = useQuery({
    queryKey: queryKeys.health.preflight,
    queryFn: ({ signal }) => client.health.preflight({ signal }),
  });
  const ready = useQuery({
    queryKey: queryKeys.health.ready,
    queryFn: ({ signal }) => client.health.ready({ signal }),
  });

  return (
    <div>
      <PageHeader
        title="Operational preflight"
        description="Dependency facts from the API. Hidden navigation is not a security control."
      />
      {preflight.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(preflight.error)}
          onRecover={() => void preflight.refetch()}
        />
      ) : null}
      <ul className="space-y-2">
        {Object.entries(preflight.data ?? {}).map(([name, ok]) => (
          <li
            key={name}
            className="flex min-h-11 items-center justify-between rounded-md border border-[var(--line)] px-3"
          >
            <span>{name}</span>
            <StatusBadge
              status={ok ? 'ready' : 'failed'}
              label={ok ? 'Available' : 'Unavailable'}
            />
          </li>
        ))}
      </ul>
      {ready.data !== undefined ? (
        <p className="mt-4 text-sm text-[var(--muted)]">
          Readiness: {ready.data.level}. Critical probes decide whether the API reports ready.
        </p>
      ) : null}
    </div>
  );
}
