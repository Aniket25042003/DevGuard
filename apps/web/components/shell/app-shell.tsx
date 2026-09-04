'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { PRODUCT_NAME } from '@/lib/brand';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, SkipLink, StatusBadge } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors';

export function AppShell({ children }: { readonly children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const params = useParams<{ repositoryId?: string }>();
  const repositoryId = typeof params.repositoryId === 'string' ? params.repositoryId : undefined;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const client = getApiClient();
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: ({ signal }) => client.auth.session({ signal }),
  });
  const repos = useQuery({
    queryKey: queryKeys.repositories.navigation,
    queryFn: ({ signal }) => client.repositories.list({ signal }),
    enabled: session.data?.authenticated === true,
  });
  const approvals = useQuery({
    queryKey: queryKeys.approvals.pendingNav,
    queryFn: ({ signal }) => client.approvals.list({ signal }, { status: 'pending', limit: 25 }),
    enabled: session.data?.authenticated === true,
  });
  const ready = useQuery({
    queryKey: queryKeys.health.ready,
    queryFn: ({ signal }) => client.health.ready({ signal }),
    enabled: session.data?.authenticated === true,
  });

  const pendingCount = approvals.data?.length ?? 0;
  const nav = (
    <nav aria-label="Primary">
      <ul className="flex flex-col gap-1">
        <NavItem
          href={buildAppHref({ name: 'home' })}
          current={pathname === '/repositories' || pathname === '/repositories/'}
        >
          Home
        </NavItem>
        <NavItem
          href={buildAppHref({ name: 'repositories' })}
          current={pathname.startsWith('/repositories')}
        >
          Repositories
        </NavItem>
        <NavItem
          href={buildAppHref({ name: 'approvals' })}
          current={pathname.startsWith('/approvals')}
        >
          <span className="flex items-center justify-between gap-3">
            Approvals
            <span className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-full bg-[var(--accent-soft)] px-2 text-xs font-semibold text-[var(--accent)]">
              {approvals.isFetching ? '…' : pendingCount}
              <span className="sr-only"> pending</span>
            </span>
          </span>
        </NavItem>
        <NavItem
          href={buildAppHref({ name: 'githubSettings' })}
          current={pathname.startsWith('/settings/github')}
        >
          GitHub connection
        </NavItem>
        <NavItem
          href={buildAppHref({ name: 'preflight' })}
          current={pathname.startsWith('/diagnostics')}
        >
          Diagnostics
        </NavItem>
        {repositoryId !== undefined ? (
          <>
            <li className="mt-6 px-3 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
              Repository
            </li>
            <NavItem
              href={buildAppHref({ name: 'repository', repositoryId })}
              current={pathname === `/repositories/${repositoryId}`}
            >
              Dashboard
            </NavItem>
            <NavItem
              href={buildAppHref({ name: 'launcher', repositoryId })}
              current={pathname.includes('/workflows/new')}
            >
              Launch workflow
            </NavItem>
            <NavItem
              href={buildAppHref({ name: 'policy', repositoryId })}
              current={pathname.includes('/policy')}
            >
              Policy
            </NavItem>
          </>
        ) : null}
      </ul>
    </nav>
  );

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SkipLink />
      <div className="lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-[var(--line)] bg-[var(--bg-muted)] lg:block">
          <div className="sticky top-0 flex h-screen flex-col p-6">
            <Link
              href={buildAppHref({ name: 'home' })}
              className="mb-10 flex items-center gap-2 font-[family-name:var(--font-display)] text-xl font-semibold tracking-tight"
            >
              <span className="size-2.5 rounded-full bg-[var(--accent)]" aria-hidden="true" />
              {PRODUCT_NAME}
            </Link>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            <ConnectionStatus
              ready={ready.data?.ready}
              level={ready.data?.level}
              user={session.data?.user?.login}
            />
          </div>
        </aside>
        <div>
          <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-3 lg:hidden">
            <button
              type="button"
              className="min-h-11 min-w-11 rounded-[var(--radius)] border border-[var(--line)] px-3 text-sm font-medium"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav"
              onClick={() => setDrawerOpen((open) => !open)}
            >
              Menu
            </button>
            <Link
              href={buildAppHref({ name: 'home' })}
              className="font-[family-name:var(--font-display)] font-semibold"
            >
              {PRODUCT_NAME}
            </Link>
            <Link
              href={buildAppHref({ name: 'approvals' })}
              className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--line)] px-3 text-sm"
            >
              Approvals
              <span
                className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]"
                aria-hidden="true"
              >
                {pendingCount}
              </span>
              <span className="sr-only">{pendingCount} pending</span>
            </Link>
          </header>
          {drawerOpen ? (
            <div
              id="mobile-nav"
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="border-b border-[var(--line)] bg-[var(--bg-elevated)] p-4 lg:hidden"
            >
              {nav}
              <Button tone="neutral" onClick={() => setDrawerOpen(false)}>
                Close menu
              </Button>
            </div>
          ) : null}
          <main id="main" className="mx-auto max-w-6xl px-4 py-10 sm:px-8 sm:py-12">
            {repos.isError ? (
              <div className="mb-4">
                <ProblemAlert
                  problem={classifyUiProblem(repos.error)}
                  onRecover={() => void repos.refetch()}
                />
              </div>
            ) : null}
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  href,
  current,
  children,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <li>
      <Link
        href={href}
        aria-current={current ? 'page' : undefined}
        className={`block min-h-10 rounded-[var(--radius-pill)] px-4 py-2.5 text-sm font-medium transition ${
          current
            ? 'bg-[var(--bg-elevated)] text-[var(--accent)] shadow-sm'
            : 'text-[var(--muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--ink)]'
        }`}
      >
        {children}
      </Link>
    </li>
  );
}

function ConnectionStatus({
  ready,
  level,
  user,
}: {
  readonly ready?: boolean | undefined;
  readonly level?: string | undefined;
  readonly user?: string | undefined;
}): ReactNode {
  const status = ready === false ? 'degraded' : ready === true ? 'ready' : 'unknown';
  return (
    <div className="mt-4 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-elevated)] p-4 text-sm shadow-sm">
      <StatusBadge status={status} label={level ?? status} />
      {user !== undefined ? (
        <p className="mt-2 truncate text-[var(--muted)]">Signed in as {user}</p>
      ) : null}
    </div>
  );
}

export function AuthGate({ children }: { readonly children: ReactNode }): ReactNode {
  const router = useRouter();
  const pathname = usePathname();
  const session = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: ({ signal }) => getApiClient().auth.session({ signal }),
  });

  useEffect(() => {
    if (session.data?.authenticated === false) {
      router.replace(buildAppHref({ name: 'signIn', returnTo: pathname }));
    }
  }, [pathname, router, session.data?.authenticated]);

  if (session.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p role="status" className="text-[var(--muted)]">
          Checking session…
        </p>
      </div>
    );
  }
  if (session.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <ProblemAlert
          problem={classifyUiProblem(session.error)}
          onRecover={() => void session.refetch()}
        />
      </div>
    );
  }
  if (session.data?.authenticated !== true) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p role="status" className="text-[var(--muted)]">
          Redirecting to sign in…
        </p>
      </div>
    );
  }
  return children;
}
