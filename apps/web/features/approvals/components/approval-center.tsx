'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import type { ApprovalSummary } from '@/lib/api/index';
import { newIdempotencyKey } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  RiskIndicator,
  SectionHeading,
  StatusBadge,
} from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
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
        title="Approval queue"
        description="Review exact, fingerprinted operations before a governed run can create an external effect."
      />
      {pending.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(pending.error)}
          onRecover={() => void pending.refetch()}
        />
      ) : null}
      {pending.isLoading ? (
        <div
          className="surface-soft rounded-[var(--radius-lg)] p-6 text-sm text-[var(--muted)]"
          role="status"
        >
          Loading approval queue…
        </div>
      ) : null}
      {pending.data !== undefined && pending.data.length === 0 ? (
        <EmptyState
          title="No pending approvals"
          body="When a run reaches a policy gate, it will appear here for every origin: web, CLI, or GitHub."
          action={
            <Button href="/repositories" tone="ghost" icon="repo">
              View repositories
            </Button>
          }
          icon="shield"
        />
      ) : null}
      {pending.data !== undefined && pending.data.length > 0 ? (
        <section>
          <SectionHeading
            title={`${pending.data.length} decision${pending.data.length === 1 ? '' : 's'} waiting`}
            description="The oldest request appears first. Approval never marks locally until the API confirms a 2xx response."
          />
          <ul className="space-y-4">
            {pending.data.map((approval) => (
              <li key={approval.approvalId}>
                <ApprovalCard approval={approval} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
  const state = approval.state.toLowerCase();
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={state} />
            {approval.riskClass ? <RiskIndicator risk={approval.riskClass} /> : null}
          </div>
          {approval.expiresAt ? (
            <span className="flex items-center gap-1 text-xs text-[var(--muted)]">
              <Icon name="clock" size={13} /> Expires{' '}
              <time dateTime={approval.expiresAt}>{approval.expiresAt}</time>
            </span>
          ) : null}
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight">
            {approval.actionType ?? 'Privileged action'}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            {approval.rationaleSummary ??
              approval.reason ??
              'The server has not provided a rationale yet.'}
          </p>
        </div>
        <div className="grid gap-3 border-y border-[var(--line)] py-4 sm:grid-cols-3">
          <Detail label="Operation" value={approval.actionType ?? 'Not specified'} />
          <Detail label="Run" value={approval.workflowRunId ?? 'Not linked'} mono />
          <Detail label="Impact" value={approval.riskClass ?? 'Read only'} />
        </div>
        {decide.isError ? <ProblemAlert problem={classifyUiProblem(decide.error)} /> : null}
        {state === 'pending' ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => decide.mutate('approve')}
              disabled={decide.isPending}
              loading={decide.isPending && decide.variables === 'approve'}
              icon="check"
            >
              Approve
            </Button>
            <Button
              tone="danger"
              onClick={() => decide.mutate('reject')}
              disabled={decide.isPending}
              loading={decide.isPending && decide.variables === 'reject'}
              icon="x"
            >
              Reject
            </Button>
            <span className="text-xs text-[var(--subtle)]">
              The server re-checks policy and target state before resuming.
            </span>
          </div>
        ) : (
          <Badge
            tone={state === 'approved' ? 'ok' : 'danger'}
            icon={state === 'approved' ? 'check' : 'x'}
          >
            {state}
          </Badge>
        )}
      </div>
    </Card>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): ReactNode {
  const displayValue = label === 'Operation' ? 'See operation above' : value;
  return (
    <div>
      <p className="meta-label">{label}</p>
      <p className={`mt-1 truncate text-sm font-semibold ${mono ? 'font-mono text-xs' : ''}`}>
        {displayValue}
      </p>
    </div>
  );
}
