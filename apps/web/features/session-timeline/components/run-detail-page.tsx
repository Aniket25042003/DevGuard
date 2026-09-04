'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import type { TimelineEvent } from '@/lib/api/index';
import { originLabel } from '@/lib/commands';
import { formatRelativeTime } from '@/lib/time';
import { queryKeys } from '@/lib/server-state/query-keys';
import { createTimelineStream, type StreamStatus } from '@/lib/server-state/stream-manager';
import {
  Badge,
  Button,
  Card,
  PageHeader,
  RiskIndicator,
  SectionHeading,
  StatusBadge,
} from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';

export function WorkflowRunDetailPage({
  repositoryId,
  runId,
}: {
  readonly repositoryId: string;
  readonly runId: string;
}): ReactNode {
  const client = getApiClient();
  const run = useQuery({
    queryKey: queryKeys.workflows.detail(runId),
    queryFn: ({ signal }) => client.workflows.get(runId, { signal }),
  });
  const approvals = useQuery({
    queryKey: queryKeys.approvals.forRun(runId),
    queryFn: ({ signal }) => client.approvals.listForRun(runId, { signal }),
  });
  const artifacts = useQuery({
    queryKey: queryKeys.artifacts.forRun(runId),
    queryFn: ({ signal }) => client.artifacts.listForWorkflow(runId, { signal }),
  });
  const findings = useQuery({
    queryKey: queryKeys.findings.forRun(runId),
    queryFn: ({ signal }) => client.findings.listForWorkflow(runId, { signal }),
  });
  const cancel = useMutation({
    mutationFn: () =>
      client.workflows.cancel(runId, {
        signal: new AbortController().signal,
        ifMatch: String(run.data?.version ?? ''),
        idempotencyKey: `cancel-${runId}`,
      }),
    onSuccess: async () => {
      await run.refetch();
    },
  });
  const sessionId = run.data?.sessionId;
  const status = run.data?.status ?? 'unknown';
  const terminal = ['completed', 'failed', 'cancelled', 'rejected', 'timed_out'].includes(status);

  return (
    <div>
      <PageHeader
        title={run.data?.workflowType.replaceAll('_', ' ') ?? 'Loading run'}
        description={
          run.data
            ? `Run ${run.data.id} · started ${formatRelativeTime(run.data.createdAt)}`
            : runId
        }
        actions={
          <Button
            href={buildAppHref({ name: 'repository', repositoryId })}
            tone="ghost"
            icon="chevron-right"
          >
            Back to repository
          </Button>
        }
      />
      {run.isError ? (
        <ProblemAlert problem={classifyUiProblem(run.error)} onRecover={() => void run.refetch()} />
      ) : null}
      {run.data ? (
        <>
          <section
            className="status-strip mb-6 flex flex-col gap-4 rounded-[var(--radius-lg)] p-5 sm:flex-row sm:items-center sm:justify-between"
            data-tone={
              status === 'waiting_for_approval'
                ? 'warn'
                : status === 'failed'
                  ? 'danger'
                  : status === 'completed'
                    ? 'ok'
                    : undefined
            }
          >
            <div className="flex items-center gap-3">
              <StatusBadge status={status} />
              <span className="h-4 w-px bg-[var(--line)]" />
              <span className="text-sm text-[var(--muted)]">
                {originLabel(run.data.trigger.originSurface)} · {run.data.trigger.triggerType}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral" icon="shield">
                Policy checked
              </Badge>
              {run.data.pullRequestNumber !== undefined ? (
                <Badge tone="neutral" icon="repo">
                  PR #{run.data.pullRequestNumber}
                </Badge>
              ) : null}
              {!terminal && (status === 'queued' || status === 'waiting_for_approval') ? (
                <Button
                  tone="danger"
                  size="sm"
                  onClick={() => cancel.mutate()}
                  disabled={cancel.isPending}
                  loading={cancel.isPending}
                >
                  {cancel.isPending ? 'Cancelling' : 'Request cancel'}
                </Button>
              ) : null}
            </div>
          </section>
          {cancel.isError ? (
            <div className="mb-5">
              <ProblemAlert problem={classifyUiProblem(cancel.error)} />
            </div>
          ) : null}
        </>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(19rem,0.65fr)]">
        <SessionTimeline sessionId={sessionId} runId={runId} />
        <aside className="space-y-6">
          <EvidencePanel title="Approvals" icon="shield" count={approvals.data?.length}>
            {(approvals.data ?? []).length === 0 ? (
              <p className="text-sm text-[var(--muted)]">
                No approval gate has been recorded for this run.
              </p>
            ) : (
              <ul className="space-y-3">
                {(approvals.data ?? []).map((approval) => (
                  <li
                    key={approval.approvalId}
                    className="border-t border-[var(--line)] pt-3 first:border-0 first:pt-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={approval.state.toLowerCase()} />
                      {approval.riskClass ? <RiskIndicator risk={approval.riskClass} /> : null}
                    </div>
                    <p className="mt-2 text-sm font-semibold">
                      {approval.actionType ?? 'Privileged action'}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                      {approval.reason ??
                        approval.rationaleSummary ??
                        'Server-provided rationale is shown when present.'}
                    </p>
                    <LinkToApprovals />
                  </li>
                ))}
              </ul>
            )}
          </EvidencePanel>
          <EvidencePanel title="Artifacts" icon="repo" count={artifacts.data?.length}>
            {(artifacts.data ?? []).length === 0 ? (
              <p className="text-sm text-[var(--muted)]">
                No safe artifacts have been published yet.
              </p>
            ) : (
              <ul className="space-y-3">
                {(artifacts.data ?? []).map((artifact) => (
                  <li
                    key={artifact.id}
                    className="flex items-start gap-3 border-t border-[var(--line)] pt-3 first:border-0 first:pt-0"
                  >
                    <Icon name="code" size={16} className="mt-0.5 text-[var(--accent)]" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        {artifact.path ?? artifact.id}
                      </p>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        Safe to retrieve
                        {artifact.sizeBytes !== undefined ? ` · ${artifact.sizeBytes} bytes` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </EvidencePanel>
          <EvidencePanel title="Findings" icon="alert" count={findings.data?.length}>
            {(findings.data ?? []).length === 0 ? (
              <p className="text-sm text-[var(--muted)]">
                No normalized findings recorded yet. This is not a clean scan unless verification
                completed.
              </p>
            ) : (
              <ul className="space-y-3">
                {(findings.data ?? []).map((finding) => (
                  <li
                    key={finding.id}
                    className="border-t border-[var(--line)] pt-3 first:border-0 first:pt-0"
                  >
                    <p className="text-sm font-semibold">{finding.rule ?? finding.id}</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {finding.severity} · {finding.status}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </EvidencePanel>
        </aside>
      </div>
    </div>
  );
}

function LinkToApprovals(): ReactNode {
  return (
    <a
      className="mt-2 inline-flex min-h-10 items-center gap-1 text-xs font-bold text-[var(--accent)] hover:underline"
      href={buildAppHref({ name: 'approvals' })}
    >
      Open approval center <Icon name="arrow-up-right" size={13} />
    </a>
  );
}

function EvidencePanel({
  title,
  icon,
  count,
  children,
}: {
  readonly title: string;
  readonly icon: 'shield' | 'repo' | 'alert';
  readonly count?: number | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name={icon} size={16} className="text-[var(--accent)]" />
          <h2 className="text-sm font-bold">{title}</h2>
        </div>
        {count !== undefined ? (
          <span className="text-xs tabular-nums text-[var(--subtle)]">{count}</span>
        ) : null}
      </div>
      {children}
    </Card>
  );
}

function SessionTimeline({
  sessionId,
  runId,
}: {
  readonly sessionId: string | undefined;
  readonly runId: string;
}): ReactNode {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const snapshot = useQuery({
    queryKey:
      sessionId !== undefined ? queryKeys.session.events(sessionId) : ['sessionEvents', 'none'],
    queryFn: ({ signal }) => client.sessions.listEvents(sessionId ?? '', { signal }),
    enabled: sessionId !== undefined,
  });
  const [liveEvents, setLiveEvents] = useState<readonly TimelineEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle');
  useEffect(() => {
    if (sessionId === undefined) return;
    const controller = new AbortController();
    const handle = createTimelineStream({
      sessionId,
      signal: controller.signal,
      onState: (state) => {
        setLiveEvents(state.events);
        setStreamStatus(state.status);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(runId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.approvals.forRun(runId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.forRun(runId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.findings.forRun(runId) }),
        ]);
      },
      pollFallback: () => client.sessions.listEvents(sessionId, { signal: controller.signal }),
    });
    return () => {
      handle.stop();
      controller.abort();
    };
  }, [client, queryClient, runId, sessionId]);
  const events = liveEvents.length > 0 ? liveEvents : (snapshot.data ?? []);
  const streamLabel =
    streamStatus === 'live'
      ? 'Live'
      : streamStatus === 'connecting'
        ? 'Connecting'
        : streamStatus === 'reconnecting'
          ? 'Reconnecting'
          : streamStatus === 'gap'
            ? 'Reconciling gap'
            : streamStatus === 'stopped'
              ? 'Stopped'
              : 'Idle';
  return (
    <section>
      <SectionHeading
        title="Execution trace"
        description="Immutable events from the governed run."
        action={
          <StatusBadge
            status={
              streamStatus === 'live' ? 'ready' : streamStatus === 'stopped' ? 'failed' : 'unknown'
            }
            label={streamLabel}
          />
        }
      />
      <Card className="p-5 sm:p-6">
        {sessionId === undefined ? (
          <div className="status-strip rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Icon name="clock" size={17} className="mt-0.5 text-[var(--warn)]" />
              <div>
                <p className="text-sm font-semibold">Session not attached yet</p>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  The run is durable, but the worker has not attached an agent session. Timeline
                  events will appear here when execution is available.
                </p>
              </div>
            </div>
          </div>
        ) : snapshot.isError ? (
          <ProblemAlert
            problem={classifyUiProblem(snapshot.error)}
            onRecover={() => void snapshot.refetch()}
          />
        ) : events.length === 0 ? (
          <div className="py-10 text-center">
            <Icon name="activity" size={24} className="mx-auto text-[var(--subtle)]" />
            <p className="mt-3 text-sm text-[var(--muted)]">
              Waiting for the first execution event…
            </p>
          </div>
        ) : (
          <ol className="timeline-rail space-y-0">
            {events.map((event) => (
              <li
                key={event.eventId ?? `${event.eventType}-${event.sequenceNumber}`}
                className="relative flex gap-4 pb-6 last:pb-0"
              >
                <span
                  className={`timeline-node ${eventStatusClass(event)}`}
                  data-status={eventStatusClass(event)}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-bold">{event.eventType}</p>
                    <span className="font-mono text-[0.6875rem] text-[var(--subtle)]">
                      #{event.sequenceNumber}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--muted)]">{event.summary}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </section>
  );
}

function eventStatusClass(event: TimelineEvent): 'active' | 'success' | 'warning' | 'danger' | '' {
  const kind = event.eventType.toLowerCase();
  if (kind.includes('fail') || kind.includes('deny') || kind.includes('error')) return 'danger';
  if (kind.includes('approval') || kind.includes('wait')) return 'warning';
  if (kind.includes('complete') || kind.includes('verified') || kind.includes('success'))
    return 'success';
  if (kind.includes('start') || kind.includes('run') || kind.includes('sandbox')) return 'active';
  return '';
}
