'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import type { TimelineEvent } from '@/lib/api/index';
import { originLabel } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import { createTimelineStream, type StreamStatus } from '@/lib/server-state/stream-manager';
import { Button, PageHeader, StatusBadge } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';
import { RiskIndicator } from '@/components/ui/primitives';

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
  });

  const sessionId = run.data?.sessionId;

  return (
    <div>
      <PageHeader
        title="Workflow run"
        description={`${run.data?.workflowType.replaceAll('_', ' ') ?? runId}`}
        actions={
          <Button href={buildAppHref({ name: 'repository', repositoryId })} tone="neutral">
            Back to dashboard
          </Button>
        }
      />
      {run.isError ? (
        <ProblemAlert problem={classifyUiProblem(run.error)} onRecover={() => void run.refetch()} />
      ) : null}
      {run.data !== undefined ? (
        <dl className="mb-6 grid gap-3 sm:grid-cols-2">
          <Item term="Status" detail={<StatusBadge status={run.data.status} />} />
          <Item term="Source" detail={originLabel(run.data.trigger.originSurface)} />
          <Item term="Trigger" detail={run.data.trigger.triggerType} />
          <Item term="Version" detail={String(run.data.version)} />
          {run.data.pullRequestNumber !== undefined ? (
            <Item term="Pull request" detail={`#${run.data.pullRequestNumber}`} />
          ) : null}
        </dl>
      ) : null}
      {run.data !== undefined &&
      (run.data.status === 'queued' || run.data.status === 'waiting_for_approval') ? (
        <div className="mb-6">
          <Button
            tone="danger"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending || run.data === undefined}
          >
            {cancel.isPending ? 'Cancelling…' : 'Request cancel'}
          </Button>
          {cancel.isError ? <ProblemAlert problem={classifyUiProblem(cancel.error)} /> : null}
        </div>
      ) : null}

      <h2 className="mb-3 text-lg font-medium">Approvals</h2>
      {(approvals.data ?? []).length === 0 ? (
        <p className="mb-6 text-[var(--muted)]">No approvals on this run.</p>
      ) : (
        <ul className="mb-6 space-y-2">
          {(approvals.data ?? []).map((approval) => (
            <li key={approval.approvalId} className="rounded-md border border-[var(--line)] p-3">
              <StatusBadge status={approval.state.toLowerCase()} />
              {approval.riskClass !== undefined ? (
                <span className="ml-3">
                  <RiskIndicator risk={approval.riskClass} />
                </span>
              ) : null}
              <p className="text-sm text-[var(--muted)]">
                {approval.reason ?? approval.rationaleSummary}
              </p>
              <a
                className="inline-flex min-h-11 items-center underline"
                href={buildAppHref({ name: 'approvals' })}
              >
                Open approval center
              </a>
            </li>
          ))}
        </ul>
      )}

      <SessionTimeline sessionId={sessionId} />

      <h2 className="mb-3 mt-8 text-lg font-medium">Artifacts</h2>
      {(artifacts.data ?? []).length === 0 ? (
        <p className="text-[var(--muted)]">No SAFE artifacts listed for this run.</p>
      ) : (
        <ul className="space-y-2">
          {(artifacts.data ?? []).map((artifact) => (
            <li key={artifact.id} className="rounded-md border border-[var(--line)] p-3">
              <p className="font-medium">{artifact.path ?? artifact.id}</p>
              <p className="text-sm text-[var(--muted)]">
                Scan state SAFE
                {artifact.sizeBytes !== undefined ? ` · ${artifact.sizeBytes} bytes` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mb-3 mt-8 text-lg font-medium">Findings</h2>
      {(findings.data ?? []).length === 0 ? (
        <p className="text-[var(--muted)]">
          No normalized findings for this run. That is not a clean scan unless a scan completed.
        </p>
      ) : (
        <ul className="space-y-2">
          {(findings.data ?? []).map((finding) => (
            <li key={finding.id} className="rounded-md border border-[var(--line)] p-3">
              <p className="font-medium">
                {finding.rule ?? finding.id} · {finding.severity} · {finding.status}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Item({ term, detail }: { readonly term: string; readonly detail: ReactNode }): ReactNode {
  return (
    <div>
      <dt className="text-sm text-[var(--muted)]">{term}</dt>
      <dd>{detail}</dd>
    </div>
  );
}

function SessionTimeline({ sessionId }: { readonly sessionId: string | undefined }): ReactNode {
  const client = getApiClient();
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
      },
      pollFallback: () => client.sessions.listEvents(sessionId, { signal: controller.signal }),
    });
    return () => {
      handle.stop();
      controller.abort();
    };
  }, [client, sessionId]);

  const events = liveEvents.length > 0 ? liveEvents : (snapshot.data ?? []);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">Timeline</h2>
        <StatusBadge
          status={
            streamStatus === 'live' ? 'ready' : streamStatus === 'stopped' ? 'failed' : 'unknown'
          }
          label={streamLabel(streamStatus)}
        />
      </div>
      {sessionId === undefined ? (
        <p className="text-[var(--muted)]">
          This run has no session id yet. Timeline appears when the worker attaches a session.
        </p>
      ) : snapshot.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(snapshot.error)}
          onRecover={() => void snapshot.refetch()}
        />
      ) : events.length === 0 ? (
        <p className="text-[var(--muted)]">No timeline events yet.</p>
      ) : (
        <ol className="space-y-3">
          {events.map((event) => (
            <li
              key={event.eventId ?? `${event.eventType}-${event.sequenceNumber}`}
              className="rounded-md border border-[var(--line)] p-3"
            >
              <p className="font-medium">{event.eventType}</p>
              <p>{event.summary}</p>
              <p className="text-sm text-[var(--muted)]">Sequence {event.sequenceNumber}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function streamLabel(status: StreamStatus): string {
  if (status === 'live') return 'Live';
  if (status === 'connecting') return 'Connecting';
  if (status === 'reconnecting') return 'Reconnecting';
  if (status === 'gap') return 'Reconciling gap';
  if (status === 'stopped') return 'Stopped';
  return 'Idle';
}
