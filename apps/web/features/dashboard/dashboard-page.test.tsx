import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests, type DevGuardApiClient } from '@/lib/api/client';
import { RunTable } from './components/dashboard-page';
import type { WorkflowRunDtoV1 } from '@devguard/api-contracts';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => '/repositories/r1',
  useParams: () => ({ repositoryId: 'r1' }),
  useSearchParams: () => new URLSearchParams('pr=9'),
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

const run = (originSurface: WorkflowRunDtoV1['trigger']['originSurface']): WorkflowRunDtoV1 =>
  ({
    id: `run-${originSurface}`,
    repositoryId: 'r1',
    workflowType: 'review_remediation',
    definitionVersion: '1',
    status: 'queued',
    trigger: { triggerType: 'manual', originSurface },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    links: { self: `/api/v1/workflows/run-${originSurface}` },
  }) as WorkflowRunDtoV1;

describe('dashboard origin column', () => {
  afterEach(() => setApiClientForTests(undefined));

  it('labels web, CLI, and GitHub origins without putting tokens in the DOM', () => {
    setApiClientForTests({} as unknown as DevGuardApiClient);
    render(
      wrap(
        createElement(RunTable, {
          repositoryId: 'r1',
          runs: [run('web'), run('cli'), run('github_comment')],
        }),
      ),
    );
    expect(screen.getByText('Web')).toBeInTheDocument();
    expect(screen.getByText('CLI')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/Authorization|devguard_session|ghp_/);
  });
});
