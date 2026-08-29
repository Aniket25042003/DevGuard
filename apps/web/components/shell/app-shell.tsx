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
        <NavItem href={buildAppHref({ name: 'home' })} current={pathname === '/'}>
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
            <span className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-full border border-[var(--line)] px-2 text-xs">
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
            <li className="mt-4 text-xs uppercase tracking-wide text-[var(--muted)]">Repository</li>
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
    <div className="min-h-screen">
      <SkipLink />
      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-[var(--line)] bg-[var(--bg-elevated)] p-4 lg:block">
          <p className="mb-6 text-lg font-semibold">{PRODUCT_NAME}</p>
          {nav}
          <ConnectionStatus
            ready={ready.data?.ready}
            level={ready.data?.level}
            user={session.data?.user?.login}
          />
        </aside>
        <div>
          <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3 lg:hidden">
            <button
              type="button"
              className="min-h-11 min-w-11 rounded-md border border-[var(--line)] px-3"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav"
              onClick={() => setDrawerOpen((open) => !open)}
            >
              Menu
            </button>
            <Link href="/" className="font-semibold">
              {PRODUCT_NAME}
            </Link>
            <Link
              href={buildAppHref({ name: 'approvals' })}
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[var(--line)] px-3"
            >
              Approvals
              <span aria-hidden="true">{pendingCount}</span>
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
          <main id="main" className="px-4 py-6 sm:px-8">
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
        className={`block min-h-11 rounded-md px-3 py-2 ${current ? 'bg-[var(--bg)] font-medium' : ''}`}
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
    <div className="mt-8 border-t border-[var(--line)] pt-4 text-sm text-[var(--muted)]">
      <StatusBadge status={status} label={level ?? status} />
      {user !== undefined ? <p className="mt-2">Signed in as {user}</p> : null}
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
      <p role="status" className="p-8">
        Checking session…
      </p>
    );
  }
  if (session.isError) {
    return (
      <div className="p-8">
        <ProblemAlert
          problem={classifyUiProblem(session.error)}
          onRecover={() => void session.refetch()}
        />
      </div>
    );
  }
  if (session.data?.authenticated !== true) {
    return (
      <p role="status" className="p-8">
        Redirecting to sign in…
      </p>
    );
  }
  return children;
}
