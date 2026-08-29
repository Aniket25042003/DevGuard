import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests, type DevGuardApiClient } from '@/lib/api/client';
import { AppShell } from './app-shell';
import { ProblemAlert } from '@/features/errors';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => '/repositories',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => createElement('a', { href, ...props }, children),
}));

function wrap(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, node);
}

describe('shell a11y', () => {
  afterEach(() => setApiClientForTests(undefined));

  it('exposes a skip link, landmarks, and requestId on errors', async () => {
    setApiClientForTests({
      auth: { session: async () => ({ authenticated: true, user: { login: 'octo' } }) },
      repositories: { list: async () => [] },
      approvals: { list: async () => [] },
      health: { ready: async () => ({ ready: true, level: 'healthy', probes: [] }) },
    } as unknown as DevGuardApiClient);

    render(wrap(createElement(AppShell, null, createElement('p', null, 'Dashboard body'))));
    expect(screen.getByRole('link', { name: /Skip to main content/i })).toHaveAttribute(
      'href',
      '#main',
    );
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    await screen.findByText('Dashboard body');

    render(
      createElement(ProblemAlert, {
        problem: {
          title: 'Something went wrong',
          body: 'failed',
          requestId: 'req-visible',
          recovery: 'none',
        },
      }),
    );
    expect(screen.getByText(/Request ID: req-visible/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ghp_|github_pat_/);
  });
});
