'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { newIdempotencyKey } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';
import type { RepositorySummary } from '@/lib/api/client';

export function RepositoryIndexPage(): ReactNode {
  const client = getApiClient();
  const repos = useQuery({
    queryKey: queryKeys.repositories.onboarding,
    queryFn: ({ signal }) => client.repositories.list({ signal }),
  });

  return (
    <div>
      <PageHeader
        title="Repositories"
        description="Choose a governed repository. Access and policy posture are decided by the API, not by this list."
        actions={
          <Button href={buildAppHref({ name: 'connectRepository' })} icon="plus">
            Connect repository
          </Button>
        }
      />
      {repos.isLoading ? (
        <div className="space-y-3" role="status">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : null}
      {repos.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(repos.error)}
          onRecover={() => void repos.refetch()}
        />
      ) : null}
      {repos.data !== undefined && repos.data.length === 0 ? (
        <EmptyState
          title="No repositories connected"
          body="Connect a repository granted to the DevGuard GitHub App. Empty is a real catalog result, not a placeholder."
          action={
            <Button href={buildAppHref({ name: 'connectRepository' })}>Start onboarding</Button>
          }
        />
      ) : (
        <ul className="grid gap-3">
          {(repos.data ?? []).map((repo) => (
            <li key={repo.id}>
              <a
                href={buildAppHref({ name: 'repository', repositoryId: repo.id })}
                className="group surface-soft flex items-center justify-between gap-4 rounded-[var(--radius-lg)] px-5 py-4 transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-muted)] text-[var(--accent)]">
                    <Icon name="repo" size={17} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold group-hover:text-[var(--accent)]">
                      {repo.fullName ?? repo.name}
                    </span>
                    <span className="mt-1 block text-xs text-[var(--muted)]">
                      {repo.defaultBranch
                        ? `Default branch: ${repo.defaultBranch}`
                        : 'Repository access granted'}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {repo.status !== undefined ? (
                    <Badge tone={repo.status === 'connected' ? 'ok' : 'neutral'}>
                      {repo.status}
                    </Badge>
                  ) : null}
                  <Icon name="chevron-right" size={16} className="text-[var(--subtle)]" />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RepositoryOnboardingPage(): ReactNode {
  const client = getApiClient();
  const router = useRouter();
  const queryClient = useQueryClient();
  const installId = useId();
  const searchId = useId();
  const installations = useQuery({
    queryKey: queryKeys.github.installations,
    queryFn: ({ signal }) => client.github.installations({ signal }),
  });
  const [installationId, setInstallationId] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (installationId.length > 0) return;
    const first = installations.data?.[0];
    if (first !== undefined) {
      setInstallationId(first.id);
    }
  }, [installationId, installations.data]);

  const candidates = useQuery({
    queryKey: queryKeys.github.installationRepositories(installationId, search),
    queryFn: ({ signal }) =>
      client.github.installationRepositories(
        installationId,
        { signal },
        search.trim().length > 0 ? { q: search.trim() } : undefined,
      ),
    enabled: installationId.length > 0,
  });

  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories.onboarding }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.github.installationRepositories(installationId, search),
      }),
    ]);
  };

  const connect = useMutation({
    mutationFn: (repo: RepositorySummary) =>
      client.repositories.connect(
        {
          installationId,
          githubRepositoryId: repo.githubRepositoryId ?? repo.id,
          owner: repo.owner ?? repo.fullName?.split('/')[0] ?? '',
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          visibility: repo.visibility,
        },
        { signal: new AbortController().signal, idempotencyKey: newIdempotencyKey() },
      ),
    onSuccess: async (connected) => {
      await invalidate();
      router.push(buildAppHref({ name: 'repository', repositoryId: connected.id }));
    },
  });

  const disconnect = useMutation({
    mutationFn: (repositoryId: string) =>
      client.repositories.disconnect(repositoryId, {
        signal: new AbortController().signal,
      }),
    onSuccess: async () => {
      await invalidate();
    },
  });

  const selectedInstallation = useMemo(
    () => (installations.data ?? []).find((item) => item.id === installationId),
    [installationId, installations.data],
  );

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Connect a repository"
        description="Repositories come from your linked GitHub App installation. Connect or disconnect with one click."
      />
      {installations.data !== undefined && installations.data.length === 0 ? (
        <EmptyState
          title="Install the GitHub App first"
          body="Link a GitHub App installation before choosing repositories."
          action={
            <Button href={buildAppHref({ name: 'githubSettings' })}>Open GitHub connection</Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <Field id={installId} label="GitHub installation">
            <select
              id={installId}
              className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
              value={installationId}
              onChange={(event) => setInstallationId(event.target.value)}
            >
              <option value="">Select installation</option>
              {(installations.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.accountLogin}
                </option>
              ))}
            </select>
          </Field>

          {installationId.length > 0 ? (
            <>
              <Field id={searchId} label="Filter repositories">
                <input
                  id={searchId}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by name or owner"
                  className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
                />
              </Field>

              {candidates.isLoading ? <p role="status">Loading repositories from GitHub…</p> : null}
              {candidates.isError ? (
                <ProblemAlert
                  problem={classifyUiProblem(candidates.error)}
                  onRecover={() => void candidates.refetch()}
                />
              ) : null}

              {candidates.data !== undefined && candidates.data.repositories.length === 0 ? (
                <EmptyState
                  title="No repositories found"
                  body={
                    selectedInstallation !== undefined
                      ? `No repositories are granted to ${selectedInstallation.accountLogin} for the DevGuard GitHub App. Update the app’s repository access on GitHub, then refresh.`
                      : 'No repositories are available for this installation.'
                  }
                  action={
                    <Button tone="neutral" onClick={() => void candidates.refetch()}>
                      Refresh list
                    </Button>
                  }
                />
              ) : null}

              {connect.isError ? (
                <div className="mb-4">
                  <ProblemAlert
                    problem={classifyUiProblem(connect.error)}
                    onRecover={() => connect.reset()}
                  />
                </div>
              ) : null}

              <ul className="space-y-3">
                {(candidates.data?.repositories ?? []).map((repo) => {
                  const busy =
                    (connect.isPending &&
                      (connect.variables?.githubRepositoryId ?? connect.variables?.id) ===
                        (repo.githubRepositoryId ?? repo.id)) ||
                    (disconnect.isPending && disconnect.variables === repo.id);
                  return (
                    <li key={repo.githubRepositoryId ?? repo.id}>
                      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="font-medium">{repo.fullName ?? repo.name}</p>
                          <p className="text-sm text-[var(--muted)]">
                            {repo.visibility ?? 'private'}
                            {repo.defaultBranch !== undefined ? ` · ${repo.defaultBranch}` : ''}
                            {repo.archived === true ? ' · archived' : ''}
                          </p>
                        </div>
                        {repo.connected ? (
                          <Button
                            tone="neutral"
                            disabled={busy}
                            onClick={() => disconnect.mutate(repo.id)}
                          >
                            {busy ? 'Disconnecting…' : 'Disconnect'}
                          </Button>
                        ) : (
                          <Button
                            disabled={busy || repo.archived === true}
                            onClick={() => connect.mutate(repo)}
                          >
                            {busy ? 'Connecting…' : 'Connect'}
                          </Button>
                        )}
                      </Card>
                    </li>
                  );
                })}
              </ul>

              {disconnect.isError ? (
                <ProblemAlert problem={classifyUiProblem(disconnect.error)} />
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}
