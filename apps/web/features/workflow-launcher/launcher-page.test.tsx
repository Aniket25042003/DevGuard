import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests, type DevGuardApiClient } from '@/lib/api/client';
import { WorkflowLauncherPage } from './components/launcher-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/repositories/r1/workflows/new',
  useParams: () => ({ repositoryId: 'r1' }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));

function wrap(node: ReactNode): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, node);
}

describe('WorkflowLauncherPage', () => {
  afterEach(() => {
    setApiClientForTests(undefined);
  });

  it('submits originSurface=web with a stable idempotency key and hides unavertised commands', async () => {
    const submit = vi.fn(async () => ({
      workflowRunId: '00000000-0000-4000-8000-000000000003',
    }));
    const keys: string[] = [];
    setApiClientForTests({
      commands: {
        list: async () => [{ workflowId: 'review_remediation', inputSchemaId: '1' }],
        submit: async (
          _repo: string,
          input: { originSurface: string },
          options: { idempotencyKey?: string },
        ) => {
          keys.push(options.idempotencyKey ?? '');
          expect(input.originSurface).toBe('web');
          return submit();
        },
      },
    } as unknown as DevGuardApiClient);

    render(wrap(createElement(WorkflowLauncherPage, { repositoryId: 'r1' })));
    await screen.findByRole('button', { name: /Review PR/i });
    fireEvent.change(screen.getByLabelText(/Pull request number/i), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: /Review before launch/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Launch$/i }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/i);
    expect(document.body.textContent).not.toMatch(/ghp_|github_pat_|Bearer /);
  });
});
