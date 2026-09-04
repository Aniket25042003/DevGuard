'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import type { OriginSurface, WorkflowRunDtoV1 } from '@devguard/api-contracts';
import { getApiClient } from '@/lib/api/client';
import { originLabel } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';
import { RepositoryLaunchTargets } from './repository-launch-targets';

const ORIGIN_FILTERS: ReadonlyArray<OriginSurface | 'all'> = [
  'all',
  'web',
  'cli',
  'github_comment',
  'github_event',
];

export function RepositoryDashboardPage({
  repositoryId,
}: {
  readonly repositoryId: string;
}): ReactNode {
  const params = useSearchParams();
  const origin = (params.get('originSurface') ?? params.get('triggerSource') ?? 'all') as
    OriginSurface | 'all';
  const pr = params.get('pr');
  const pullRequestNumber = pr !== null && /^\d+$/.test(pr) ? Number(pr) : undefined;
  const client = getApiClient();

  const repository = useQuery({
    queryKey: queryKeys.repositories.detail(repositoryId),
    queryFn: ({ signal }) => client.repositories.get(repositoryId, { signal }),
  });
  const runs = useQuery({
    queryKey: queryKeys.workflows.list(repositoryId, {
      scope: 'recent',
      ...(origin !== 'all' ? { originSurface: origin } : {}),
      ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
    }),
    queryFn: ({ signal }) =>
      client.workflows.list(
        repositoryId,
        { signal },
        {
          ...(origin !== 'all' ? { originSurface: origin } : {}),
          ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
          limit: 25,
        },
      ),
  });
  const approvals = useQuery({
    queryKey: queryKeys.approvals.list({ repositoryId, status: 'pending' }),
    queryFn: ({ signal }) =>
      client.approvals.list({ signal }, { repositoryId, status: 'pending', limit: 25 }),
  });
  const policy = useQuery({
    queryKey: queryKeys.policy.active(repositoryId),
    queryFn: ({ signal }) => client.policies.get(repositoryId, { signal }),
  });

  const active = useMemo(
    () =>
      (runs.data?.runs ?? []).filter((run) =>
        [
          'queued',
          'running',
          'waiting_for_approval',
          'resuming',
          'verifying',
          'cancelling',
        ].includes(run.status),
      ),
    [runs.data],
  );

  return (
    <div>
      <PageHeader
        title={repository.data?.fullName ?? repository.data?.name ?? 'Repository'}
        description="Runs from web, CLI, and GitHub share this history. Status is server-confirmed."
        actions={
          <Button href={buildAppHref({ name: 'launcher', repositoryId })}>Launch workflow</Button>
        }
      />
      {repository.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(repository.error)}
          onRecover={() => void repository.refetch()}
        />
      ) : null}
      <section className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          title="Pending approvals"
          value={String(approvals.data?.length ?? (approvals.isLoading ? '…' : 0))}
          href={buildAppHref({ name: 'approvals' })}
        />
        <SummaryCard
          title="Autonomy"
          value={policy.data?.document.autonomy.level ?? (policy.isLoading ? '…' : 'unknown')}
          href={buildAppHref({ name: 'policy', repositoryId })}
        />
        <SummaryCard
          title="Active runs"
          value={String(active.length)}
          href={buildAppHref({ name: 'launcher', repositoryId })}
        />
        <SummaryCard
          title="Policy source"
          value={policy.data?.source ?? 'unknown'}
          href={buildAppHref({ name: 'policy', repositoryId })}
        />
      </section>
      <RepositoryLaunchTargets repositoryId={repositoryId} />
      <OriginFilter repositoryId={repositoryId} current={origin} pr={pr} />
      {pullRequestNumber !== undefined ? (
        <p className="mb-3 text-sm">Filtered to pull request #{pullRequestNumber}.</p>
      ) : null}
      {runs.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(runs.error)}
          onRecover={() => void runs.refetch()}
        />
      ) : null}
      {runs.isLoading ? <p role="status">Loading runs…</p> : null}
      {runs.data !== undefined && runs.data.runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          body="Launch a workflow from this page or wait for a CLI/GitHub-origin run. This list is empty because the API returned no rows."
          action={
            <Button href={buildAppHref({ name: 'launcher', repositoryId })}>Review PR</Button>
          }
        />
      ) : (
        <RunTable repositoryId={repositoryId} runs={runs.data?.runs ?? []} />
      )}
    </div>
  );
}

function SummaryCard({
  title,
  value,
  href,
}: {
  readonly title: string;
  readonly value: string;
  readonly href: string;
}): ReactNode {
  return (
    <Link
      href={href}
      className="group surface-soft rounded-[var(--radius-lg)] p-6 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]"
    >
      <p className="text-sm font-medium text-[var(--muted)]">{title}</p>
      <p className="mt-2 font-[family-name:var(--font-display)] text-2xl font-semibold group-hover:text-[var(--accent)]">
        {value}
      </p>
    </Link>
  );
}

function OriginFilter({
  repositoryId,
  current,
  pr,
}: {
  readonly repositoryId: string;
  readonly current: OriginSurface | 'all';
  readonly pr: string | null;
}): ReactNode {
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by source">
      {ORIGIN_FILTERS.map((value) => {
        const params = new URLSearchParams();
        if (value !== 'all') params.set('originSurface', value);
        if (pr !== null) params.set('pr', pr);
        const href = `${buildAppHref({ name: 'repository', repositoryId })}${params.size > 0 ? `?${params}` : ''}`;
        const selected = current === value || (value === 'all' && current === 'all');
        return (
          <Link
            key={value}
            href={href}
            aria-current={selected ? 'page' : undefined}
            className={`min-h-10 rounded-[var(--radius-pill)] border px-4 py-2 text-sm font-medium transition ${
              selected
                ? 'border-transparent bg-[var(--accent)] text-[var(--accent-ink)] shadow-[var(--shadow-accent)]'
                : 'border-[var(--line)] bg-[var(--bg-elevated)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
            }`}
          >
            {value === 'all' ? 'All sources' : originLabel(value)}
          </Link>
        );
      })}
    </div>
  );
}

export function RunTable({
  repositoryId,
  runs,
}: {
  readonly repositoryId: string;
  readonly runs: readonly WorkflowRunDtoV1[];
}): ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <caption className="sr-only">Workflow runs including CLI and GitHub origins</caption>
        <thead>
          <tr className="text-sm text-[var(--muted)]">
            <th className="py-2 pr-3 font-medium">Workflow</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Source</th>
            <th className="py-2 pr-3 font-medium">Trigger</th>
            <th className="py-2 pr-3 font-medium">Created</th>
            <th className="py-2 font-medium">Run</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td className="py-3 pr-3">{run.workflowType.replaceAll('_', ' ')}</td>
              <td className="py-3 pr-3">
                <StatusBadge status={run.status} />
              </td>
              <td className="py-3 pr-3">{originLabel(run.trigger.originSurface)}</td>
              <td className="py-3 pr-3">{run.trigger.triggerType}</td>
              <td className="py-3 pr-3">
                <time dateTime={run.createdAt}>{run.createdAt}</time>
              </td>
              <td className="py-3">
                <Link
                  className="inline-flex min-h-10 items-center text-[var(--accent)] underline-offset-2 hover:underline"
                  href={buildAppHref({ name: 'run', repositoryId, runId: run.id })}
                >
                  View run
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
