'use client';

import { useQuery } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Card, PageHeader, SectionHeading, StatusBadge } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
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
        description="Dependency facts from the API. Launch and write capabilities remain gated when a critical dependency is unavailable."
      />
      {preflight.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(preflight.error)}
          onRecover={() => void preflight.refetch()}
        />
      ) : null}
      <SectionHeading
        title="Capability readiness"
        description="Each dependency reports its actual server-observed state."
      />
      <Card className="overflow-hidden p-0">
        <ul className="grid gap-px bg-[var(--line)] sm:grid-cols-2">
          {Object.entries(preflight.data ?? {}).map(([name, ok]) => (
            <li
              key={name}
              className="flex min-h-16 items-center justify-between bg-[var(--bg-elevated)] px-5"
            >
              <span className="flex items-center gap-3">
                <Icon name="activity" size={16} className="text-[var(--subtle)]" />
                <span className="font-medium capitalize">{name}</span>
              </span>
              <StatusBadge
                status={ok ? 'ready' : 'failed'}
                label={ok ? 'Available' : 'Unavailable'}
              />
            </li>
          ))}
        </ul>
      </Card>
      {ready.data !== undefined ? (
        <p className="mt-4 text-sm text-[var(--muted)]">
          Readiness: {ready.data.level}. Critical probes decide whether the API reports ready.
        </p>
      ) : null}
    </div>
  );
}
