'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';
import { formatRelativeTime } from '@/features/workflow-launcher/components/target-picker';

export function RepositoryLaunchTargets({
  repositoryId,
}: {
  readonly repositoryId: string;
}): ReactNode {
  const client = getApiClient();
  const pullRequests = useQuery({
    queryKey: queryKeys.repositoryTargets.pullRequests(repositoryId),
    queryFn: ({ signal }) =>
      client.repositoryTargets.pullRequests(repositoryId, { signal }, { state: 'open', limit: 8 }),
  });
  const issues = useQuery({
    queryKey: queryKeys.repositoryTargets.issues(repositoryId),
    queryFn: ({ signal }) =>
      client.repositoryTargets.issues(repositoryId, { signal }, { state: 'open', limit: 8 }),
  });

  if (pullRequests.isLoading && issues.isLoading) {
    return <p className="mb-6 text-sm text-[var(--muted)]">Loading launch targets…</p>;
  }

  return (
    <section className="mb-8 grid gap-6 lg:grid-cols-2">
      <LaunchTargetCard
        title="Open pull requests"
        isLoading={pullRequests.isLoading}
        isError={pullRequests.isError}
        error={pullRequests.error}
        onRecover={() => void pullRequests.refetch()}
        emptyMessage="No open pull requests."
        actionHref={buildAppHref({ name: 'launcher', repositoryId })}
        actionLabel="Launch workflow"
        items={(pullRequests.data ?? []).map((pr) => (
          <li key={pr.number}>
            <Link
              href={buildAppHref({
                name: 'launcher',
                repositoryId,
                search: `?command=review_remediation&pr=${pr.number}`,
              })}
              className="block rounded-lg border border-[var(--line)] px-4 py-3 transition hover:border-[var(--accent)]"
            >
              <span className="font-medium">
                #{pr.number} {pr.title}
              </span>
              <span className="mt-1 block text-sm text-[var(--muted)]">
                {pr.headRef} → {pr.baseRef} · {formatRelativeTime(pr.updatedAt)}
              </span>
            </Link>
          </li>
        ))}
      />
      <LaunchTargetCard
        title="Open issues"
        isLoading={issues.isLoading}
        isError={issues.isError}
        error={issues.error}
        onRecover={() => void issues.refetch()}
        emptyMessage="No open issues."
        actionHref={buildAppHref({
          name: 'launcher',
          repositoryId,
          search: '?command=implement_issue',
        })}
        actionLabel="Implement issue"
        items={(issues.data ?? []).map((issue) => (
          <li key={issue.number}>
            <Link
              href={buildAppHref({
                name: 'launcher',
                repositoryId,
                search: `?command=implement_issue&issue=${issue.number}`,
              })}
              className="block rounded-lg border border-[var(--line)] px-4 py-3 transition hover:border-[var(--accent)]"
            >
              <span className="font-medium">
                #{issue.number} {issue.title}
              </span>
              <span className="mt-1 block text-sm text-[var(--muted)]">
                {issue.authorLogin} · {formatRelativeTime(issue.updatedAt)}
              </span>
            </Link>
          </li>
        ))}
      />
    </section>
  );
}

function LaunchTargetCard({
  title,
  isLoading,
  isError,
  error,
  onRecover,
  emptyMessage,
  actionHref,
  actionLabel,
  items,
}: {
  readonly title: string;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly onRecover: () => void;
  readonly emptyMessage: string;
  readonly actionHref: string;
  readonly actionLabel: string;
  readonly items: readonly ReactNode[];
}): ReactNode {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg-elevated)] p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-medium">{title}</h2>
        <Button href={actionHref}>{actionLabel}</Button>
      </div>
      {isError ? <ProblemAlert problem={classifyUiProblem(error)} onRecover={onRecover} /> : null}
      {isLoading ? <p className="text-sm text-[var(--muted)]">Loading…</p> : null}
      {!isLoading && !isError ? (
        <ul className="space-y-2">
          {items.length === 0 ? (
            <li className="text-sm text-[var(--muted)]">{emptyMessage}</li>
          ) : (
            items
          )}
        </ul>
      ) : null}
    </div>
  );
}
