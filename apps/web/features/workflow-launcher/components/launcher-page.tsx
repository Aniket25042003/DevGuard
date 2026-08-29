'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { getApiClient, type GitRefSummary, type IssueSummary, type PullRequestSummary, type RepositoryFindingSummary } from '@/lib/api/client';
import { COMMAND_BUTTONS, newIdempotencyKey } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, PageHeader } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';
import {
  formatRelativeTime,
  ManualEntryToggle,
  TargetPicker,
  useDebouncedSearch,
  useRepositoryFindings,
  useRepositoryIssues,
  useRepositoryPullRequests,
  useRepositoryRefs,
} from './target-picker';

export function WorkflowLauncherPage({
  repositoryId,
}: {
  readonly repositoryId: string;
}): ReactNode {
  const client = getApiClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const commands = useQuery({
    queryKey: queryKeys.commands.available(repositoryId),
    queryFn: ({ signal }) => client.commands.list(repositoryId, { signal }),
  });
  const repository = useQuery({
    queryKey: queryKeys.repositories.detail(repositoryId),
    queryFn: ({ signal }) => client.repositories.get(repositoryId, { signal }),
  });
  const advertised = new Set((commands.data ?? []).map((item) => item.workflowId));
  const initialCommand = searchParams.get('command');
  const initialPr = searchParams.get('pr');
  const initialIssue = searchParams.get('issue');
  const [selected, setSelected] = useState<string>(
    initialCommand !== null && initialCommand.length > 0
      ? initialCommand
      : 'review_remediation',
  );
  const [prNumber, setPrNumber] = useState(initialPr ?? '');
  const [issueNumber, setIssueNumber] = useState(initialIssue ?? '');
  const [checkRunId, setCheckRunId] = useState('');
  const [findingIds, setFindingIds] = useState<string[]>([]);
  const [refName, setRefName] = useState('');
  const [manualPr, setManualPr] = useState(false);
  const [manualIssue, setManualIssue] = useState(false);
  const [manualRef, setManualRef] = useState(false);
  const [manualFindings, setManualFindings] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const idempotencyRef = useRef<string | undefined>(undefined);
  const prSearch = useDebouncedSearch();
  const issueSearch = useDebouncedSearch();
  const refSearch = useDebouncedSearch();
  const prId = useId();
  const issueId = useId();
  const checkId = useId();
  const findingId = useId();
  const refId = useId();
  const { pullRequests } = useRepositoryPullRequests(repositoryId, prSearch.debounced);
  const { issues } = useRepositoryIssues(repositoryId, issueSearch.debounced);
  const { refs } = useRepositoryRefs(repositoryId, refSearch.debounced);
  const { findings } = useRepositoryFindings(repositoryId);

  useEffect(() => {
    if (initialPr !== null && /^\d+$/.test(initialPr)) {
      setPrNumber(initialPr);
    }
    if (initialIssue !== null && /^\d+$/.test(initialIssue)) {
      setIssueNumber(initialIssue);
    }
    if (repository.data?.defaultBranch !== undefined && refName === '') {
      setRefName(repository.data.defaultBranch);
    }
  }, [initialIssue, initialPr, repository.data?.defaultBranch, refName]);

  const launch = useMutation({
    mutationFn: async () => {
      idempotencyRef.current ??= newIdempotencyKey();
      const descriptor = commands.data?.find((item) => item.workflowId === selected);
      const input = buildInput(selected, {
        prNumber,
        issueNumber,
        checkRunId,
        findingIds: findingIds.join(','),
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

  const prItems: Array<{ readonly key: string; readonly pr: PullRequestSummary }> = (
    pullRequests.data ?? []
  ).map((pr) => ({
    key: String(pr.number),
    pr,
  }));
  const issueItems: Array<{ readonly key: string; readonly issue: IssueSummary }> = (
    issues.data ?? []
  ).map((issue) => ({
    key: String(issue.number),
    issue,
  }));
  const refItems: Array<{ readonly key: string; readonly ref: GitRefSummary }> = (
    refs.data ?? []
  ).map((ref) => ({
    key: ref.name,
    ref,
  }));
  const findingItems: Array<{ readonly key: string; readonly finding: RepositoryFindingSummary }> = (
    findings.data ?? []
  ).map((finding) => ({
    key: finding.id,
    finding,
  }));

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Launch workflow"
        description="Pick a pull request, issue, branch, or finding from GitHub, then launch with one click."
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
          if (
            !enabled &&
            commands.data !== undefined &&
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
                    Not allowed by policy for this repository.
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
          <div className="space-y-3">
            {!manualPr ? (
              <TargetPicker
                label="Open pull requests"
                items={prItems}
                selectedKey={prNumber !== '' ? prNumber : undefined}
                onSelect={(item) => setPrNumber(String(item.pr.number))}
                isLoading={pullRequests.isLoading}
                isError={pullRequests.isError}
                error={pullRequests.error}
                onRecover={() => void pullRequests.refetch()}
                emptyMessage="No open pull requests found for this repository."
                searchPlaceholder="Search by title or number"
                searchValue={prSearch.value}
                onSearchChange={prSearch.setValue}
                renderItem={(item) => (
                  <>
                    <span className="font-medium">
                      #{item.pr.number} {item.pr.title}
                      {item.pr.draft ? (
                        <span className="ml-2 text-sm text-[var(--muted)]">draft</span>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-sm text-[var(--muted)]">
                      {item.pr.headRef} → {item.pr.baseRef} · {item.pr.authorLogin} ·{' '}
                      {formatRelativeTime(item.pr.updatedAt)}
                    </span>
                  </>
                )}
              />
            ) : null}
            <ManualEntryToggle enabled={manualPr} onToggle={() => setManualPr((value) => !value)}>
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
            </ManualEntryToggle>
          </div>
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
          <div className="space-y-3">
            {!manualIssue ? (
              <TargetPicker
                label="Open issues"
                items={issueItems}
                selectedKey={issueNumber !== '' ? issueNumber : undefined}
                onSelect={(item) => setIssueNumber(String(item.issue.number))}
                isLoading={issues.isLoading}
                isError={issues.isError}
                error={issues.error}
                onRecover={() => void issues.refetch()}
                emptyMessage="No open issues found for this repository."
                searchPlaceholder="Search by title or number"
                searchValue={issueSearch.value}
                onSearchChange={issueSearch.setValue}
                renderItem={(item) => (
                  <>
                    <span className="font-medium">
                      #{item.issue.number} {item.issue.title}
                    </span>
                    <span className="mt-1 block text-sm text-[var(--muted)]">
                      {item.issue.authorLogin} · {formatRelativeTime(item.issue.updatedAt)}
                      {item.issue.labels.length > 0
                        ? ` · ${item.issue.labels.join(', ')}`
                        : null}
                    </span>
                  </>
                )}
              />
            ) : null}
            <ManualEntryToggle
              enabled={manualIssue}
              onToggle={() => setManualIssue((value) => !value)}
            >
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
            </ManualEntryToggle>
          </div>
        ) : null}
        {selected === 'security_patch' ? (
          <div className="space-y-3">
            {!manualFindings ? (
              <TargetPicker
                label="Open security findings"
                items={findingItems}
                selectedKey={findingIds[0]}
                onSelect={(item) => setFindingIds([item.finding.id])}
                isLoading={findings.isLoading}
                isError={findings.isError}
                error={findings.error}
                onRecover={() => void findings.refetch()}
                emptyMessage="No open findings yet. Run a security audit first."
                renderItem={(item) => (
                  <>
                    <span className="font-medium">{item.finding.title}</span>
                    <span className="mt-1 block text-sm text-[var(--muted)]">
                      {item.finding.severity} · {item.finding.status}
                      {item.finding.filePath !== undefined ? ` · ${item.finding.filePath}` : null}
                    </span>
                  </>
                )}
              />
            ) : null}
            <ManualEntryToggle
              enabled={manualFindings}
              onToggle={() => setManualFindings((value) => !value)}
            >
              <Labeled id={findingId} label="Finding ids (comma-separated)">
                <input
                  id={findingId}
                  value={findingIds.join(', ')}
                  onChange={(event) =>
                    setFindingIds(
                      event.target.value
                        .split(',')
                        .map((value) => value.trim())
                        .filter((value) => value.length > 0),
                    )
                  }
                  className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
                />
              </Labeled>
            </ManualEntryToggle>
          </div>
        ) : null}
        {selected === 'security_audit' ? (
          <div className="space-y-3">
            {!manualRef ? (
              <TargetPicker
                label="Git refs"
                items={refItems}
                selectedKey={refName !== '' ? refName : undefined}
                onSelect={(item) => setRefName(item.ref.name)}
                isLoading={refs.isLoading}
                isError={refs.isError}
                error={refs.error}
                onRecover={() => void refs.refetch()}
                emptyMessage="No branches found for this repository."
                searchPlaceholder="Search branches"
                searchValue={refSearch.value}
                onSearchChange={refSearch.setValue}
                renderItem={(item) => (
                  <>
                    <span className="font-medium">
                      {item.ref.name}
                      {item.ref.isDefault ? (
                        <span className="ml-2 text-sm text-[var(--muted)]">default</span>
                      ) : null}
                    </span>
                    <span className="mt-1 block font-mono text-xs text-[var(--muted)]">
                      {item.ref.commitSha.slice(0, 7)}
                    </span>
                  </>
                )}
              />
            ) : null}
            <ManualEntryToggle enabled={manualRef} onToggle={() => setManualRef((value) => !value)}>
              <Labeled id={refId} label="Git ref (optional)">
                <input
                  id={refId}
                  value={refName}
                  onChange={(event) => setRefName(event.target.value)}
                  className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
                />
              </Labeled>
            </ManualEntryToggle>
          </div>
        ) : null}
        <Button type="submit" disabled={!canSubmit(selected, { prNumber, issueNumber, findingIds })}>
          Review before launch
        </Button>
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
            Repository <strong>{repository.data?.fullName ?? repositoryId}</strong> · command{' '}
            <strong>{selected}</strong> · origin <strong>web</strong>.
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

function canSubmit(
  commandId: string,
  fields: { readonly prNumber: string; readonly issueNumber: string; readonly findingIds: readonly string[] },
): boolean {
  if (commandId === 'review_remediation' || commandId === 'diagnose_failure') {
    return /^\d+$/.test(fields.prNumber);
  }
  if (commandId === 'implement_issue') {
    return /^\d+$/.test(fields.issueNumber);
  }
  if (commandId === 'security_patch') {
    return fields.findingIds.length > 0;
  }
  return true;
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
