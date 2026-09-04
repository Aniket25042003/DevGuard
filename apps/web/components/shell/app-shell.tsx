'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { PRODUCT_NAME } from '@/lib/brand';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, SkipLink, StatusBadge } from '@/components/ui/primitives';
import { Icon, type IconName } from '@/components/ui/icons';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors';

export function AppShell({ children }: { readonly children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const params = useParams<{ repositoryId?: string }>();
  const repositoryId = typeof params.repositoryId === 'string' ? params.repositoryId : undefined;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
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
  const currentRepository = repos.data?.find((repo) => repo.id === repositoryId);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const nav = (
    <nav aria-label="Primary">
      <p className="nav-group-label mb-2 px-3">Workspace</p>
      <ul className="space-y-1">
        <NavItem
          href={buildAppHref({ name: 'home' })}
          icon="home"
          current={pathname === '/repositories' || pathname === '/repositories/'}
        >
          Workspace
        </NavItem>
        <NavItem
          href={buildAppHref({ name: 'approvals' })}
          icon="shield"
          current={pathname.startsWith('/approvals')}
          count={approvals.isFetching ? '…' : (approvals.data?.length ?? 0)}
        >
          Approvals
        </NavItem>
        <NavItem
          href={buildAppHref({ name: 'githubSettings' })}
          icon="github"
          current={pathname.startsWith('/settings/github')}
        >
          GitHub access
        </NavItem>
      </ul>
      {repositoryId !== undefined ? (
        <div className="mt-8">
          <p className="nav-group-label mb-2 px-3">Repository</p>
          <div
            className="mb-2 truncate px-3 text-sm font-semibold"
            title={currentRepository?.fullName ?? repositoryId}
          >
            {currentRepository?.fullName ?? repositoryId}
          </div>
          <ul className="space-y-1">
            <NavItem
              href={buildAppHref({ name: 'repository', repositoryId })}
              icon="activity"
              current={pathname === `/repositories/${repositoryId}`}
            >
              Overview
            </NavItem>
            <NavItem
              href={buildAppHref({ name: 'launcher', repositoryId })}
              icon="play"
              current={pathname.includes('/workflows/new')}
            >
              Launch workflow
            </NavItem>
            <NavItem
              href={buildAppHref({ name: 'policy', repositoryId })}
              icon="sliders"
              current={pathname.includes('/policy')}
            >
              Policy
            </NavItem>
          </ul>
        </div>
      ) : null}
      <div className="mt-8">
        <p className="nav-group-label mb-2 px-3">System</p>
        <ul className="space-y-1">
          <NavItem
            href={buildAppHref({ name: 'preflight' })}
            icon="activity"
            current={pathname.startsWith('/diagnostics')}
          >
            Diagnostics
          </NavItem>
        </ul>
      </div>
    </nav>
  );

  return (
    <div className="app-frame lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      <SkipLink />
      <aside className="app-sidebar hidden border-r border-[var(--line)] lg:block">
        <div className="sticky top-0 flex h-screen flex-col px-4 py-5">
          <Link
            href={buildAppHref({ name: 'home' })}
            className="mb-10 flex items-center gap-3 px-3"
            aria-label={`${PRODUCT_NAME} workspace`}
          >
            <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
              <Icon name="shield" size={17} />
            </span>
            <span>
              <span className="block text-sm font-bold tracking-tight">{PRODUCT_NAME}</span>
              <span className="block text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-[var(--subtle)]">
                Control plane
              </span>
            </span>
          </Link>
          <div className="flex-1 overflow-y-auto">{nav}</div>
          <ConnectionStatus
            ready={ready.data?.ready}
            level={ready.data?.level}
            user={session.data?.user?.login}
          />
        </div>
      </aside>
      <div className="min-w-0">
        <header className="app-topbar sticky top-0 z-30 flex min-h-16 items-center justify-between gap-3 px-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              ref={closeRef}
              type="button"
              className="icon-button lg:hidden"
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Icon name="menu" size={19} />
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {currentRepository?.fullName ??
                  (repositoryId ? repositoryId : 'Workspace overview')}
              </p>
              <p className="hidden text-xs text-[var(--subtle)] sm:block">
                {repositoryId ? 'Repository context' : 'Governed agent operations'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge
              status={
                ready.data?.ready === true
                  ? 'ready'
                  : ready.data?.ready === false
                    ? 'degraded'
                    : 'unknown'
              }
              label={
                ready.data?.ready === true
                  ? 'Systems ready'
                  : ready.data?.ready === false
                    ? 'Attention needed'
                    : 'Checking systems'
              }
            />
            <span className="hidden h-5 w-px bg-[var(--line)] sm:block" />
            <Link
              href={buildAppHref({ name: 'approvals' })}
              className="hidden text-xs font-semibold text-[var(--muted)] hover:text-[var(--accent)] sm:block"
            >
              {approvals.data?.length ?? 0} pending
            </Link>
          </div>
        </header>
        {drawerOpen ? (
          <MobileDrawer closeRef={closeRef} nav={nav} onClose={() => setDrawerOpen(false)} />
        ) : null}
        <main id="main" className="page-shell">
          {repos.isError ? (
            <div className="mb-5">
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
  );
}

function NavItem({
  href,
  current,
  children,
  icon,
  count,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly children: ReactNode;
  readonly icon: IconName;
  readonly count?: number | string;
}): ReactNode {
  return (
    <li>
      <Link
        href={href}
        aria-current={current ? 'page' : undefined}
        className={`nav-item ${current ? 'nav-item-current' : ''}`}
      >
        <Icon name={icon} size={16} />
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {count !== undefined ? <span className="nav-count">{count}</span> : null}
      </Link>
    </li>
  );
}

function MobileDrawer({
  nav,
  onClose,
  closeRef,
}: {
  readonly nav: ReactNode;
  readonly onClose: () => void;
  readonly closeRef: React.RefObject<HTMLButtonElement | null>;
}): ReactNode {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 lg:hidden"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="flex h-full w-[min(21rem,88vw)] flex-col border-r border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-5"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        <div className="mb-8 flex items-center justify-between px-3">
          <span className="text-sm font-bold">Navigation</span>
          <button
            ref={closeRef}
            type="button"
            className="icon-button"
            aria-label="Close navigation"
            onClick={onClose}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="overflow-y-auto">{nav}</div>
        <div className="mt-auto pt-6">
          <Button tone="ghost" onClick={onClose} icon="close">
            Close menu
          </Button>
        </div>
      </aside>
    </div>
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
    <div className="mt-4 border-t border-[var(--line)] px-3 pt-4">
      <StatusBadge status={status} label={level ?? status} />
      <p className="mt-2 truncate text-xs text-[var(--subtle)]">
        {user ? `Signed in as ${user}` : 'Session pending'}
      </p>
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
    if (session.data?.authenticated === false)
      router.replace(buildAppHref({ name: 'signIn', returnTo: pathname }));
  }, [pathname, router, session.data?.authenticated]);
  if (session.isLoading)
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="text-center">
          <span className="mb-3 inline-flex size-10 animate-pulse items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <Icon name="shield" size={20} />
          </span>
          <p role="status" className="text-sm text-[var(--muted)]">
            Checking your workspace session…
          </p>
        </div>
      </div>
    );
  if (session.isError)
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <ProblemAlert
          problem={classifyUiProblem(session.error)}
          onRecover={() => void session.refetch()}
        />
      </div>
    );
  if (session.data?.authenticated !== true)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p role="status" className="text-sm text-[var(--muted)]">
          Redirecting to sign in…
        </p>
      </div>
    );
  return children;
}
