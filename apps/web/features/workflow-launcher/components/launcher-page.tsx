'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { COMMAND_BUTTONS, newIdempotencyKey } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, PageHeader } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';

export function WorkflowLauncherPage({
  repositoryId,
}: {
  readonly repositoryId: string;
}): ReactNode {
  const client = getApiClient();
  const router = useRouter();
  const commands = useQuery({
    queryKey: queryKeys.commands.available(repositoryId),
    queryFn: ({ signal }) => client.commands.list(repositoryId, { signal }),
  });
  const advertised = new Set((commands.data ?? []).map((item) => item.workflowId));
  const [selected, setSelected] = useState<string>('review_remediation');
  const [prNumber, setPrNumber] = useState('');
  const [issueNumber, setIssueNumber] = useState('');
  const [checkRunId, setCheckRunId] = useState('');
  const [findingIds, setFindingIds] = useState('');
  const [refName, setRefName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const idempotencyRef = useRef<string | undefined>(undefined);
  const prId = useId();
  const issueId = useId();
  const checkId = useId();
  const findingId = useId();
  const refId = useId();

  const launch = useMutation({
    mutationFn: async () => {
      idempotencyRef.current ??= newIdempotencyKey();
      const descriptor = commands.data?.find((item) => item.workflowId === selected);
      const input = buildInput(selected, {
        prNumber,
        issueNumber,
        checkRunId,
        findingIds,
        refName,
      });
      return client.commands.submit(
        repositoryId,
        {
          commandId: selected,
          definitionVersion: descriptor?.inputSchemaId ?? '1',
          input,
          originSurface: 'web',
        },
        { signal: new AbortController().signal, idempotencyKey: idempotencyRef.current },
      );
    },
    onSuccess: (receipt) => {
      router.push(buildAppHref({ name: 'run', repositoryId, runId: receipt.workflowRunId }));
    },
  });

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Launch workflow"
        description="Only server-advertised commands are shown. Launching creates a durable run with originSurface=web."
      />
      {commands.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(commands.error)}
          onRecover={() => void commands.refetch()}
        />
      ) : null}
      <ul className="mb-6 grid gap-3">
        {COMMAND_BUTTONS.map((command) => {
          const enabled = advertised.has(command.commandId);
          const extensionHidden =
            !enabled && !advertised.has(command.commandId) && commands.data !== undefined;
          if (
            extensionHidden &&
            ![
              'review_remediation',
              'diagnose_failure',
              'security_audit',
              'security_patch',
              'implement_issue',
            ].includes(command.commandId)
          ) {
            return null;
          }
          return (
            <li key={command.commandId}>
              <button
                type="button"
                disabled={!enabled && commands.data !== undefined}
                onClick={() => setSelected(command.commandId)}
                className={`w-full rounded-lg border px-4 py-3 text-left ${selected === command.commandId ? 'border-[var(--ink)]' : 'border-[var(--line)]'}`}
              >
                <span className="font-medium">{command.label}</span>
                <span className="mt-1 block text-sm text-[var(--muted)]">
                  {command.description}
                </span>
                {!enabled && commands.data !== undefined ? (
                  <span className="mt-1 block text-sm">
                    Not advertised by the server for this repository.
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          setConfirming(true);
        }}
      >
        {selected === 'review_remediation' || selected === 'diagnose_failure' ? (
          <Labeled id={prId} label="Pull request number">
            <input
              id={prId}
              required
              inputMode="numeric"
              value={prNumber}
              onChange={(event) => setPrNumber(event.target.value)}
              className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
            />
          </Labeled>
        ) : null}
        {selected === 'diagnose_failure' ? (
          <Labeled id={checkId} label="Check run id (optional)">
            <input
              id={checkId}
              value={checkRunId}
              onChange={(event) => setCheckRunId(event.target.value)}
              className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
            />
          </Labeled>
        ) : null}
        {selected === 'implement_issue' ? (
          <Labeled id={issueId} label="Issue number">
            <input
              id={issueId}
              required
              inputMode="numeric"
              value={issueNumber}
              onChange={(event) => setIssueNumber(event.target.value)}
              className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
            />
          </Labeled>
        ) : null}
        {selected === 'security_patch' ? (
          <Labeled id={findingId} label="Finding ids (comma-separated)">
            <input
              id={findingId}
              value={findingIds}
              onChange={(event) => setFindingIds(event.target.value)}
              className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
            />
          </Labeled>
        ) : null}
        {selected === 'security_audit' ? (
          <Labeled id={refId} label="Git ref (optional)">
            <input
              id={refId}
              value={refName}
              onChange={(event) => setRefName(event.target.value)}
              className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
            />
          </Labeled>
        ) : null}
        <Button type="submit">Review before launch</Button>
      </form>
      {confirming ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="launch-review-title"
          className="mt-6 rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)] p-4"
        >
          <h2 id="launch-review-title" className="text-lg font-medium">
            Confirm launch
          </h2>
          <p className="mt-2">
            Repository <strong>{repositoryId}</strong> · command <strong>{selected}</strong> ·
            origin <strong>web</strong>.
          </p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            A 202 means the run is queued, not completed. The same idempotency key is reused if this
            click retries.
          </p>
          {launch.isError ? <ProblemAlert problem={classifyUiProblem(launch.error)} /> : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={() => launch.mutate()} disabled={launch.isPending}>
              {launch.isPending ? 'Submitting…' : 'Launch'}
            </Button>
            <Button tone="neutral" onClick={() => setConfirming(false)} disabled={launch.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Labeled({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function buildInput(
  commandId: string,
  fields: {
    readonly prNumber: string;
    readonly issueNumber: string;
    readonly checkRunId: string;
    readonly findingIds: string;
    readonly refName: string;
  },
): unknown {
  if (commandId === 'review_remediation') return { pullRequestNumber: Number(fields.prNumber) };
  if (commandId === 'diagnose_failure') {
    return {
      pullRequestNumber: Number(fields.prNumber),
      ...(fields.checkRunId !== '' ? { checkRunId: fields.checkRunId } : {}),
    };
  }
  if (commandId === 'implement_issue') return { issueNumber: Number(fields.issueNumber) };
  if (commandId === 'security_patch') {
    return {
      findingIds: fields.findingIds
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    };
  }
  if (commandId === 'security_audit') {
    return fields.refName !== '' ? { ref: fields.refName } : {};
  }
  return {};
}
