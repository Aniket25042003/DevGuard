'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { PRODUCT_NAME } from '@/lib/brand';
import { validateReturnTo } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, Card } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';

export function SignInPage(): ReactNode {
  const params = useSearchParams();
  const returnTo = validateReturnTo(params.get('returnTo'));
  const href = getApiClient().loginHref(returnTo);
  const [busy, setBusy] = useState(false);

  return (
    <div className="hero-glow flex min-h-screen flex-col">
      <header className="px-4 py-6 sm:px-8">
        <Link
          href="/"
          className="font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight"
        >
          {PRODUCT_NAME}
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <Card className="w-full max-w-md p-8">
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight">
            Welcome back
          </h1>
          <p className="mt-2 text-[var(--muted)]">
            Sign in with GitHub to access your governed workspace. Sessions are HttpOnly cookies — no
            personal access tokens required.
          </p>
          <ul className="mt-6 space-y-3 text-sm text-[var(--muted)]">
            <li className="flex gap-2">
              <span className="text-[var(--accent)]" aria-hidden="true">
                ✓
              </span>
              Identity sign-in is separate from GitHub App repository access
            </li>
            <li className="flex gap-2">
              <span className="text-[var(--accent)]" aria-hidden="true">
                ✓
              </span>
              Privileged actions require in-product approval
            </li>
            <li className="flex gap-2">
              <span className="text-[var(--accent)]" aria-hidden="true">
                ✓
              </span>
              Agent code runs in sandboxed workspaces, not on the host
            </li>
          </ul>
          <div className="mt-8">
            <Button
              size="lg"
              href={busy ? undefined : href}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                window.location.assign(href);
              }}
            >
              {busy ? 'Redirecting to GitHub…' : 'Continue with GitHub'}
            </Button>
          </div>
          <p className="mt-6 text-center text-sm text-[var(--muted)]">
            <Link href="/" className="underline-offset-2 hover:underline">
              ← Back to home
            </Link>
          </p>
        </Card>
      </div>
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
      <div className="hero-glow flex min-h-screen items-center justify-center px-4">
        <Card className="w-full max-w-lg p-8">
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">
            Sign-in did not complete
          </h1>
          <div className="mt-4">
            <ProblemAlert
              problem={{
                title: 'GitHub returned an error',
                body: description ?? error,
                recovery: 'sign-in',
              }}
            />
          </div>
          <div className="mt-6">
            <Button href={buildAppHref({ name: 'signIn' })}>Try again</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (code !== null && state !== null) {
    const target = `/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return <CallbackRedirect target={target} />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p role="status" className="text-[var(--muted)]">
        Waiting for GitHub callback…
      </p>
    </div>
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
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight">
            GitHub connection
          </h1>
          <p className="mt-2 text-[var(--muted)]">
            Installations and repository grants are recorded by the API. This page does not talk to GitHub
            directly.
          </p>
        </div>
        <Button tone="neutral" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Sign out
        </Button>
      </header>
      {installations.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(installations.error)}
          onRecover={() => void installations.refetch()}
        />
      ) : null}
      {installations.isLoading ? <p role="status">Loading installations…</p> : null}
      {installations.data !== undefined && installations.data.length === 0 ? (
        <Card className="p-8">
          <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold">
            No GitHub App installation on file
          </h2>
          <p className="mt-2 text-[var(--muted)]">
            Sign-in proves your identity. Repository access requires the DevGuard GitHub App. After
            installing on GitHub, link the installation to your account below.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={() => startInstall.mutate()} disabled={startInstall.isPending}>
              {startInstall.isPending ? 'Starting…' : 'Connect GitHub App'}
            </Button>
            <Button tone="neutral" href={buildAppHref({ name: 'githubSetup' })}>
              Link existing installation
            </Button>
          </div>
          <p className="mt-4 text-sm text-[var(--muted)]">
            Set your GitHub App setup URL to{' '}
            <code className="rounded bg-[var(--bg-muted)] px-1.5 py-0.5">
              https://devguard-olive.vercel.app/settings/github/setup
            </code>{' '}
            so GitHub redirects here automatically after install.
          </p>
          {startInstall.isError ? (
            <div className="mt-4">
              <ProblemAlert problem={classifyUiProblem(startInstall.error)} />
            </div>
          ) : null}
        </Card>
      ) : (
        <ul className="space-y-3">
          {(installations.data ?? []).map((installation) => (
            <li key={installation.id}>
              <Card className="p-5">
                <p className="font-medium">{installation.accountLogin}</p>
                <p className="text-sm text-[var(--muted)]">
                  {installation.accountType} · {installation.status}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <h2 className="mt-10 font-[family-name:var(--font-display)] text-xl font-semibold">
        Connected repositories
      </h2>
      {(repos.data ?? []).length === 0 ? (
        <p className="mt-2 text-[var(--muted)]">
          None yet. Continue to repository onboarding after an installation exists.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {(repos.data ?? []).map((repo) => (
            <li key={repo.id} className="rounded-lg border border-[var(--line)] bg-[var(--bg-muted)] px-4 py-2">
              {repo.fullName ?? repo.name}
            </li>
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
    <div className="flex min-h-screen items-center justify-center">
      <p role="status" className="text-[var(--muted)]">
        Completing sign-in with the control plane…
      </p>
    </div>
  );
}
