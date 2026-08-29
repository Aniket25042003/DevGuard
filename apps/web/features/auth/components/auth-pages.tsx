'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { PRODUCT_NAME } from '@/lib/brand';
import { validateReturnTo } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, PageHeader } from '@/components/ui/primitives';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';

export function SignInPage(): ReactNode {
  const params = useSearchParams();
  const returnTo = validateReturnTo(params.get('returnTo'));
  const href = getApiClient().loginHref(returnTo);
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <PageHeader
        title={`Sign in to ${PRODUCT_NAME}`}
        description="GitHub OAuth creates an HttpOnly session cookie. DevGuard never asks for a personal access token."
      />
      <ul className="mb-6 list-disc space-y-2 pl-5 text-[var(--muted)]">
        <li>Identity sign-in is separate from GitHub App repository access.</li>
        <li>Privileged actions still require in-product approval.</li>
        <li>Generated code runs in a sandbox, not on the DevGuard host.</li>
      </ul>
      <Button
        href={busy ? undefined : href}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          window.location.assign(href);
        }}
      >
        {busy ? 'Redirecting to GitHub…' : 'Sign in with GitHub'}
      </Button>
    </div>
  );
}

export function AuthCallbackPage(): ReactNode {
  const params = useSearchParams();
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const description = params.get('error_description');

  if (error !== null) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <PageHeader title="Sign-in did not complete" />
        <ProblemAlert
          problem={{
            title: 'GitHub returned an error',
            body: description ?? error,
            recovery: 'sign-in',
          }}
        />
      </div>
    );
  }

  if (code !== null && state !== null) {
    const target = `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return <CallbackRedirect target={target} />;
  }

  return (
    <p role="status" className="p-8">
      Waiting for GitHub callback…
    </p>
  );
}

export function GitHubConnectionPage(): ReactNode {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const installations = useQuery({
    queryKey: queryKeys.github.installations,
    queryFn: ({ signal }) => client.github.installations({ signal }),
  });
  const repos = useQuery({
    queryKey: queryKeys.repositories.onboarding,
    queryFn: ({ signal }) => client.repositories.list({ signal }),
  });
  const startInstall = useMutation({
    mutationFn: () => client.github.startInstallation({ signal: new AbortController().signal }),
    onSuccess: (result) => {
      window.location.assign(result.installUrl);
    },
  });
  const logout = useMutation({
    mutationFn: () => client.auth.logout({ signal: new AbortController().signal }),
    onSuccess: async () => {
      queryClient.clear();
      window.location.assign('/sign-in');
    },
  });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="GitHub connection"
        description="Installations and repository grants are recorded by the API. This page does not talk to GitHub directly."
        actions={
          <Button tone="neutral" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Sign out
          </Button>
        }
      />
      {installations.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(installations.error)}
          onRecover={() => void installations.refetch()}
        />
      ) : null}
      {installations.isLoading ? <p role="status">Loading installations…</p> : null}
      {installations.data !== undefined && installations.data.length === 0 ? (
        <div className="rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-6">
          <h2 className="text-lg font-medium">No GitHub App installation on file</h2>
          <p className="mt-2 text-[var(--muted)]">
            Sign-in proves your identity. Repository access requires the DevGuard GitHub App. Start
            installation from the server so the callback stays on this origin.
          </p>
          <div className="mt-4">
            <Button onClick={() => startInstall.mutate()} disabled={startInstall.isPending}>
              {startInstall.isPending ? 'Starting…' : 'Connect GitHub App'}
            </Button>
          </div>
          {startInstall.isError ? (
            <div className="mt-4">
              <ProblemAlert problem={classifyUiProblem(startInstall.error)} />
            </div>
          ) : null}
        </div>
      ) : (
        <ul className="space-y-3">
          {(installations.data ?? []).map((installation) => (
            <li key={installation.id} className="rounded-lg border border-[var(--line)] p-4">
              <p className="font-medium">{installation.accountLogin}</p>
              <p className="text-sm text-[var(--muted)]">
                {installation.accountType} · {installation.status}
              </p>
            </li>
          ))}
        </ul>
      )}
      <h2 className="mt-8 text-lg font-medium">Connected repositories</h2>
      {(repos.data ?? []).length === 0 ? (
        <p className="mt-2 text-[var(--muted)]">
          None yet. Continue to repository onboarding after an installation exists.
        </p>
      ) : (
        <ul className="mt-2 list-disc pl-5">
          {(repos.data ?? []).map((repo) => (
            <li key={repo.id}>{repo.fullName ?? repo.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CallbackRedirect({ target }: { readonly target: string }): ReactNode {
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return (
    <p role="status" className="p-8">
      Completing sign-in with the control plane…
    </p>
  );
}
