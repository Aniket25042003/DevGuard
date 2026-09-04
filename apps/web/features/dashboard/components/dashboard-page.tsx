'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import type { OriginSurface, WorkflowRunDtoV1 } from '@devguard/api-contracts';
import { getApiClient } from '@/lib/api/client';
import { originLabel } from '@/lib/commands';
import { formatDateTime, formatRelativeTime } from '@/lib/time';
import { queryKeys } from '@/lib/server-state/query-keys';
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  SectionHeading,
  StatusBadge,
} from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
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
          'dispatch_pending',
          'running',
          'waiting_for_approval',
          'resuming',
          'verifying',
          'cancelling',
        ].includes(run.status),
      ),
    [runs.data],
  );
  const repoName = repository.data?.fullName ?? repository.data?.name ?? repositoryId;

  return (
    <div>
      <PageHeader
        title={repoName}
        description="A live view of governed work, human decisions, and the evidence behind every run."
        actions={
          <Button href={buildAppHref({ name: 'launcher', repositoryId })} icon="play">
            Launch workflow
          </Button>
        }
      />
      {repository.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(repository.error)}
          onRecover={() => void repository.refetch()}
        />
      ) : null}

      <section className="mb-8 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <div
          className={`surface rounded-[var(--radius-lg)] p-6 ${approvals.data && approvals.data.length > 0 ? 'status-strip' : ''}`}
          data-tone={approvals.data && approvals.data.length > 0 ? 'warn' : undefined}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold tracking-tight">
                {approvals.isLoading
                  ? 'Checking approvals…'
                  : approvals.data?.length
                    ? `${approvals.data.length} action${approvals.data.length === 1 ? '' : 's'} waiting`
                    : 'Nothing waiting for approval'}
              </h2>
              <p className="mt-2 max-w-xl text-sm text-[var(--muted)]">
                {approvals.data?.length
                  ? 'Review the exact operation and its evidence before authorizing a privileged effect.'
                  : 'When a run reaches a policy gate, the action and fingerprint will appear here.'}
              </p>
            </div>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-elevated)] text-[var(--warn)]">
              <Icon name={approvals.data?.length ? 'alert' : 'shield'} size={20} />
            </span>
          </div>
          {approvals.data && approvals.data.length > 0 ? (
            <ul className="mt-5 divide-y divide-[var(--line)] border-t border-[var(--line)]">
              {approvals.data.slice(0, 3).map((approval) => (
                <li
                  key={approval.approvalId}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {approval.actionType ?? 'Privileged action'}
                    </p>
                    <p className="truncate text-xs text-[var(--muted)]">
                      {approval.reason ??
                        approval.rationaleSummary ??
                        'Server-provided rationale available in approval center.'}
                    </p>
                  </div>
                  <Link
                    href={buildAppHref({ name: 'approvals' })}
                    className="shrink-0 text-xs font-bold text-[var(--accent)] hover:underline"
                  >
                    Review <span aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="surface-inset rounded-[var(--radius-lg)] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold tracking-tight">
                {runs.isLoading
                  ? 'Loading activity…'
                  : active.length
                    ? `${active.length} active run${active.length === 1 ? '' : 's'}`
                    : 'No active runs'}
              </h2>
              <p className="mt-2 text-sm text-[var(--muted)]">
                Queued and live work stays visible until the server confirms its outcome.
              </p>
            </div>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
              <Icon name="activity" size={20} />
            </span>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Badge tone="accent" icon="activity">
              {active.length} active
            </Badge>
            <Badge tone="neutral" icon="sliders">
              Autonomy: {policy.data?.document.autonomy.level ?? 'unknown'}
            </Badge>
          </div>
        </div>
      </section>

      <RepositoryLaunchTargets repositoryId={repositoryId} />
      <section className="mt-8">
        <SectionHeading
          title="Run history"
          description="Work from web, CLI, and GitHub share one server-confirmed history."
          action={
            <Link
              href={buildAppHref({ name: 'launcher', repositoryId })}
              className="text-xs font-bold text-[var(--accent)] hover:underline"
            >
              View all activity <span aria-hidden="true">→</span>
            </Link>
          }
        />
        <OriginFilter repositoryId={repositoryId} current={origin} pr={pr} />
        {pullRequestNumber !== undefined ? (
          <p className="mb-3 text-xs text-[var(--muted)]">
            Filtered to pull request #{pullRequestNumber}.
          </p>
        ) : null}
        {runs.isError ? (
          <ProblemAlert
            problem={classifyUiProblem(runs.error)}
            onRecover={() => void runs.refetch()}
          />
        ) : null}
        {runs.isLoading ? (
          <div
            className="surface-soft rounded-[var(--radius-lg)] p-6 text-sm text-[var(--muted)]"
            role="status"
          >
            Loading run history…
          </div>
        ) : null}
        {runs.data !== undefined && runs.data.runs.length === 0 ? (
          <EmptyState
            title="No runs yet"
            body="Launch a workflow from this repository or wait for a CLI/GitHub-origin run."
            action={
              <Button href={buildAppHref({ name: 'launcher', repositoryId })} icon="play">
                Launch first workflow
              </Button>
            }
            icon="activity"
          />
        ) : null}
        {runs.data !== undefined && runs.data.runs.length > 0 ? (
          <div className="surface-soft overflow-hidden rounded-[var(--radius-lg)]">
            <RunTable repositoryId={repositoryId} runs={runs.data.runs} />
          </div>
        ) : null}
      </section>
    </div>
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
        const selected = current === value;
        return (
          <Link
            key={value}
            href={href}
            aria-current={selected ? 'page' : undefined}
            className={`button button-sm ${selected ? 'button-primary' : 'button-ghost'}`}
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
          <tr>
            <th className="px-5 py-3">Workflow</th>
            <th className="px-3 py-3">Status</th>
            <th className="px-3 py-3">Source</th>
            <th className="px-3 py-3">Updated</th>
            <th className="px-5 py-3 text-right">Open</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td className="px-5 py-4">
                <p className="font-semibold">{run.workflowType.replaceAll('_', ' ')}</p>
                <p className="mt-0.5 font-mono text-[0.6875rem] text-[var(--subtle)]">{run.id}</p>
              </td>
              <td className="px-3 py-4">
                <StatusBadge status={run.status} />
              </td>
              <td className="px-3 py-4 text-sm text-[var(--muted)]">
                {originLabel(run.trigger.originSurface)}
              </td>
              <td className="px-3 py-4 text-sm text-[var(--muted)]">
                <time dateTime={run.updatedAt} title={formatDateTime(run.updatedAt)}>
                  {formatRelativeTime(run.updatedAt)}
                </time>
              </td>
              <td className="px-5 py-4 text-right">
                <Link
                  className="inline-flex min-h-11 items-center gap-1 text-xs font-bold text-[var(--accent)] hover:underline"
                  href={buildAppHref({ name: 'run', repositoryId, runId: run.id })}
                >
                  View run <Icon name="arrow-up-right" size={14} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
