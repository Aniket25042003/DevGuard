'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import type { ApprovalSummary } from '@/lib/api/index';
import { newIdempotencyKey } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import {
  Button,
  EmptyState,
  PageHeader,
  RiskIndicator,
  StatusBadge,
} from '@/components/ui/primitives';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';

export function ApprovalCenterPage(): ReactNode {
  const client = getApiClient();
  const pending = useQuery({
    queryKey: queryKeys.approvals.list({ status: 'pending' }),
    queryFn: ({ signal }) => client.approvals.list({ signal }, { status: 'pending', limit: 50 }),
  });

  return (
    <div>
      <PageHeader
        title="Approval center"
        description="Approve or reject the exact fingerprinted operation. The UI waits for a 2xx; it never marks an approval resolved locally."
      />
      {pending.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(pending.error)}
          onRecover={() => void pending.refetch()}
        />
      ) : null}
      {pending.isLoading ? <p role="status">Loading approvals…</p> : null}
      {pending.data !== undefined && pending.data.length === 0 ? (
        <EmptyState
          title="No pending approvals"
          body="When a workflow pauses for a privileged action, it appears here for every origin — web, CLI, or GitHub."
        />
      ) : (
        <ul className="space-y-4">
          {(pending.data ?? []).map((approval) => (
            <li key={approval.approvalId}>
              <ApprovalCard approval={approval} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApprovalCard({ approval }: { readonly approval: ApprovalSummary }): ReactNode {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const approveKey = useRef(newIdempotencyKey());
  const rejectKey = useRef(newIdempotencyKey());
  const decide = useMutation({
    mutationFn: (action: 'approve' | 'reject') =>
      client.approvals.decide(
        approval.approvalId,
        action,
        {
          signal: new AbortController().signal,
          idempotencyKey: action === 'approve' ? approveKey.current : rejectKey.current,
        },
        approval.workflowRunId,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  return (
    <article className="rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-4">
      <header className="flex flex-wrap items-center gap-3">
        <StatusBadge status={approval.state.toLowerCase()} />
        {approval.riskClass !== undefined ? <RiskIndicator risk={approval.riskClass} /> : null}
      </header>
      <p className="mt-2 font-medium">{approval.actionType ?? 'Privileged action'}</p>
      <p className="mt-1 text-[var(--muted)]">
        {approval.rationaleSummary ??
          approval.reason ??
          'Server-provided rationale is shown when present.'}
      </p>
      {approval.expiresAt !== undefined ? (
        <p className="mt-1 text-sm">
          Expires <time dateTime={approval.expiresAt}>{approval.expiresAt}</time>
        </p>
      ) : null}
      {decide.isError ? <ProblemAlert problem={classifyUiProblem(decide.error)} /> : null}
      {approval.state.toLowerCase() === 'pending' ? (
        <div className="mt-4 flex flex-wrap gap-3">
          <Button onClick={() => decide.mutate('approve')} disabled={decide.isPending}>
            {decide.isPending && decide.variables === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
          <Button tone="danger" onClick={() => decide.mutate('reject')} disabled={decide.isPending}>
            {decide.isPending && decide.variables === 'reject' ? 'Rejecting…' : 'Reject'}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
