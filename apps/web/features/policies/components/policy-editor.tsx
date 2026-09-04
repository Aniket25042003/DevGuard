'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import type { PolicyDocument } from '@/lib/api/client';
import { getApiClient } from '@/lib/api/client';
import { newIdempotencyKey } from '@/lib/commands';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, PageHeader } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';

const ACTION_TYPES = [
  'repository.read',
  'issue.read',
  'file.read',
  'pull_request.create',
  'commit.push',
  'pull_request.merge',
  'workflow_file.write',
  'branch.delete',
  'sandbox.command',
] as const;

const AUTONOMY = ['assist', 'developer', 'trusted', 'autonomous'] as const;

const DEFAULT_POLICY = (owner: string, name: string): PolicyDocument => ({
  schemaVersion: 1,
  repository: { owner, name },
  autonomy: { level: 'assist' },
  triggers: {},
  manualCommands: [
    'review_remediation',
    'diagnose_failure',
    'security_audit',
    'security_patch',
    'implement_issue',
  ],
  actions: {
    allow: ['repository.read', 'issue.read', 'file.read'],
    requireApproval: ['pull_request.merge', 'workflow_file.write'],
    deny: [],
  },
  validation: { obligations: ['run_tests'] },
  limits: { maxFilesChanged: 25, maxIterations: 6, maxRuntimeMinutes: 20 },
});

export function PolicyEditorPage({ repositoryId }: { readonly repositoryId: string }): ReactNode {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const active = useQuery({
    queryKey: queryKeys.policy.active(repositoryId),
    queryFn: ({ signal }) => client.policies.get(repositoryId, { signal }),
  });
  const repository = useQuery({
    queryKey: queryKeys.repositories.detail(repositoryId),
    queryFn: ({ signal }) => client.repositories.get(repositoryId, { signal }),
  });
  const [draft, setDraft] = useState<PolicyDocument | undefined>(undefined);
  const [digest, setDigest] = useState<string | undefined>(undefined);
  const [danger, setDanger] = useState<readonly string[]>([]);
  const current =
    draft ??
    active.data?.document ??
    DEFAULT_POLICY(repository.data?.owner ?? 'owner', repository.data?.name ?? 'name');
  const updateDraft = (next: PolicyDocument): void => {
    setDraft(next);
    setDigest(undefined);
    setDanger([]);
  };

  const validate = useMutation({
    mutationFn: () =>
      client.policies.validate(repositoryId, current, { signal: new AbortController().signal }),
    onSuccess: (result) => {
      setDraft(result.canonical);
      setDigest(result.draftDigest);
      setDanger(result.dangerChanges);
    },
  });
  const save = useMutation({
    mutationFn: () =>
      client.policies.update(
        repositoryId,
        { draft: current, draftDigest: digest ?? '' },
        {
          signal: new AbortController().signal,
          idempotencyKey: newIdempotencyKey(),
          ifMatch: active.data?.etag,
        },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.policy.active(repositoryId) });
      setDigest(undefined);
    },
  });

  const yamlPreview = useMemo(() => JSON.stringify(current, null, 2), [current]);

  return (
    <div>
      <PageHeader
        title="Repository policy"
        description={`Source: ${active.data?.source ?? 'defaults'} · version ${active.data?.activeVersion ?? 0}. Canonical policy is previewed read-only.`}
        actions={
          <Button href={buildAppHref({ name: 'policyHistory', repositoryId })} tone="neutral">
            History
          </Button>
        }
      />
      {active.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(active.error)}
          onRecover={() => void active.refetch()}
        />
      ) : null}
      <fieldset className="mb-6">
        <legend className="mb-2 font-medium">Autonomy</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {AUTONOMY.map((level) => (
            <label
              key={level}
              className="flex min-h-11 items-center gap-2 rounded-md border border-[var(--line)] px-3"
            >
              <input
                type="radio"
                name="autonomy"
                checked={current.autonomy.level === level}
                onChange={() => updateDraft({ ...current, autonomy: { level } })}
              />
              {level}
            </label>
          ))}
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Autonomous never removes hard safety gates. The server re-validates every save.
        </p>
      </fieldset>
      <fieldset className="mb-6">
        <legend className="mb-2 font-medium">Action effects</legend>
        <div className="space-y-2">
          {ACTION_TYPES.map((action) => (
            <div
              key={action}
              className="grid gap-2 rounded-md border border-[var(--line)] p-3 md:grid-cols-[1fr_auto_auto_auto]"
            >
              <p className="font-medium">{action}</p>
              {(['allow', 'requireApproval', 'deny'] as const).map((effect) => (
                <label key={effect} className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name={`action-${action}`}
                    checked={current.actions[effect].includes(action)}
                    onChange={() => updateDraft(setActionEffect(current, action, effect))}
                  />
                  {effect === 'allow'
                    ? 'Allow'
                    : effect === 'requireApproval'
                      ? 'Require approval'
                      : 'Forbid'}
                </label>
              ))}
            </div>
          ))}
        </div>
      </fieldset>
      <fieldset className="mb-6 grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 font-medium">Limits</legend>
        <NumberField
          label="Max files changed"
          value={current.limits.maxFilesChanged}
          onChange={(value) =>
            updateDraft({ ...current, limits: { ...current.limits, maxFilesChanged: value } })
          }
        />
        <NumberField
          label="Max iterations"
          value={current.limits.maxIterations}
          onChange={(value) =>
            updateDraft({ ...current, limits: { ...current.limits, maxIterations: value } })
          }
        />
        <NumberField
          label="Max runtime minutes"
          value={current.limits.maxRuntimeMinutes}
          onChange={(value) =>
            updateDraft({ ...current, limits: { ...current.limits, maxRuntimeMinutes: value } })
          }
        />
      </fieldset>
      <fieldset className="mb-6">
        <legend className="mb-2 font-medium">Required validations</legend>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={current.validation.obligations.includes('run_tests')}
            onChange={(event) =>
              updateDraft({
                ...current,
                validation: {
                  obligations: event.target.checked ? ['run_tests'] : [],
                },
              })
            }
          />
          Run tests before merge
        </label>
      </fieldset>
      {validate.data !== undefined && validate.data.issues.length > 0 ? (
        <ul className="mb-4 list-disc pl-5 text-[var(--danger)]">
          {validate.data.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {danger.length > 0 ? (
        <div role="alert" className="mb-4 rounded-md border border-[var(--line)] p-3">
          <p className="font-medium">Danger-increasing changes (server classification)</p>
          <ul className="mt-2 list-disc pl-5">
            {danger.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-3">
        <Button onClick={() => validate.mutate()} disabled={validate.isPending}>
          {validate.isPending ? 'Validating…' : 'Validate and preview'}
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || digest === undefined}>
          {save.isPending ? 'Saving…' : 'Save new version'}
        </Button>
      </div>
      {validate.isError ? <ProblemAlert problem={classifyUiProblem(validate.error)} /> : null}
      {save.isError ? <ProblemAlert problem={classifyUiProblem(save.error)} /> : null}
      <h2 className="mb-2 text-lg font-medium">Canonical policy preview (read-only)</h2>
      <pre className="overflow-x-auto rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] p-3 text-sm">
        {yamlPreview}
      </pre>
    </div>
  );
}

export function PolicyHistoryPage({ repositoryId }: { readonly repositoryId: string }): ReactNode {
  const versions = useQueryHistory(repositoryId);
  return (
    <div>
      <PageHeader
        title="Policy history"
        description="Immutable versions. Rollback creates a new version after server validation."
        actions={
          <Button href={buildAppHref({ name: 'policy', repositoryId })} tone="neutral">
            Back to editor
          </Button>
        }
      />
      {versions.isError ? (
        <ProblemAlert
          problem={classifyUiProblem(versions.error)}
          onRecover={() => void versions.refetch()}
        />
      ) : null}
      <ul className="space-y-2">
        {(versions.data ?? []).map((version) => (
          <li key={version.version} className="rounded-md border border-[var(--line)] p-3">
            <p className="font-medium">Version {version.version}</p>
            <p className="text-sm text-[var(--muted)]">
              {version.createdBy} · <time dateTime={version.createdAt}>{version.createdAt}</time>
            </p>
            <p className="font-mono text-xs break-all">{version.canonicalHash}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function useQueryHistory(repositoryId: string) {
  const client = getApiClient();
  return useQuery({
    queryKey: queryKeys.policy.history(repositoryId),
    queryFn: ({ signal }) => client.policies.versions(repositoryId, { signal }),
  });
}

function NumberField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}): ReactNode {
  const id = label.replaceAll(' ', '-').toLowerCase();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
      />
    </div>
  );
}

function setActionEffect(
  document: PolicyDocument,
  action: string,
  effect: 'allow' | 'requireApproval' | 'deny',
): PolicyDocument {
  const strip = (list: readonly string[]): string[] => list.filter((item) => item !== action);
  return {
    ...document,
    actions: {
      allow:
        effect === 'allow'
          ? [...strip(document.actions.allow), action]
          : strip(document.actions.allow),
      requireApproval:
        effect === 'requireApproval'
          ? [...strip(document.actions.requireApproval), action]
          : strip(document.actions.requireApproval),
      deny:
        effect === 'deny'
          ? [...strip(document.actions.deny), action]
          : strip(document.actions.deny),
    },
  };
}
