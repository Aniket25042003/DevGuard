import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApiClientForTests, type DevGuardApiClient } from '@/lib/api/client';
import { ApprovalCenterPage } from './components/approval-center';

function wrap(node: ReactNode): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, node);
}

describe('ApprovalCenterPage', () => {
  afterEach(() => {
    setApiClientForTests(undefined);
  });

  it('waits for 2xx before treating an approval as resolved', async () => {
    let resolveDecide: ((value: { resolved: boolean; approvalId: string }) => void) | undefined;
    const decide = vi.fn(
      () =>
        new Promise<{ resolved: boolean; approvalId: string }>((resolve) => {
          resolveDecide = resolve;
        }),
    );
    setApiClientForTests({
      approvals: {
        list: async () => [
          {
            approvalId: 'appr-1',
            state: 'pending',
            actionType: 'pull_request.merge',
            riskClass: 'sensitive_write',
            reason: 'Merge requires approval',
          },
        ],
        decide,
      },
    } as unknown as DevGuardApiClient);

    render(wrap(createElement(ApprovalCenterPage)));
    await screen.findByText('pull_request.merge');
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/i }));
    expect(screen.queryByText(/^Approved$/i)).toBeNull();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    resolveDecide?.({ resolved: true, approvalId: 'appr-1' });
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toMatch(/secret|token|ghp_/i);
  });
});
