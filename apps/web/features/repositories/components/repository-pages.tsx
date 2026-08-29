'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { newIdempotencyKey } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, EmptyState, PageHeader } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';

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
        description="Select a connected repository. Access is decided by the API, not by this list."
        actions={
          <Button href={buildAppHref({ name: 'connectRepository' })}>Connect repository</Button>
        }
      />
      {repos.isLoading ? <p role="status">Loading repositories…</p> : null}
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
                className="block min-h-11 rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-3"
              >
                <span className="font-medium">{repo.fullName ?? repo.name}</span>
                {repo.status !== undefined ? (
                  <span className="ml-2 text-sm text-[var(--muted)]">{repo.status}</span>
                ) : null}
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
  const ownerId = useId();
  const nameId = useId();
  const installId = useId();
  const githubId = useId();
  const installations = useQuery({
    queryKey: queryKeys.github.installations,
    queryFn: ({ signal }) => client.github.installations({ signal }),
  });
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [githubRepositoryId, setGithubRepositoryId] = useState('');
  const [idempotencyKey] = useState(newIdempotencyKey);

  const connect = useMutation({
    mutationFn: () =>
      client.repositories.connect(
        { installationId, githubRepositoryId, owner, name },
        { signal: new AbortController().signal, idempotencyKey },
      ),
    onSuccess: (repo) => {
      router.push(buildAppHref({ name: 'repository', repositoryId: repo.id }));
    },
  });

  return (
    <div className="max-w-xl">
      <PageHeader
        title="Connect a repository"
        description="Confirm the exact owner/name. The server re-checks installation grants; this form is not authorization."
      />
      {installations.data !== undefined && installations.data.length === 0 ? (
        <EmptyState
          title="Install the GitHub App first"
          body="Candidate discovery needs a recorded installation. Identity sign-in is not enough."
          action={
            <Button href={buildAppHref({ name: 'githubSettings' })}>Open GitHub connection</Button>
          }
        />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate();
          }}
        >
          <Field id={installId} label="Installation">
            <select
              id={installId}
              required
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
          <Field id={ownerId} label="Owner">
            <input
              id={ownerId}
              required
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
            />
          </Field>
          <Field id={nameId} label="Repository name">
            <input
              id={nameId}
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
            />
          </Field>
          <Field id={githubId} label="GitHub repository id">
            <input
              id={githubId}
              required
              inputMode="numeric"
              value={githubRepositoryId}
              onChange={(event) => setGithubRepositoryId(event.target.value)}
              className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
            />
          </Field>
          {connect.isError ? <ProblemAlert problem={classifyUiProblem(connect.error)} /> : null}
          <Button type="submit" disabled={connect.isPending}>
            {connect.isPending ? 'Connecting…' : 'Connect this repository'}
          </Button>
        </form>
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
