'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { getApiClient, type GitRefSummary, type IssueSummary, type PullRequestSummary, type RepositoryFindingSummary } from '@/lib/api/client';
import { queryKeys } from '@/lib/server-state/query-keys';
import { ProblemAlert, classifyUiProblem } from '@/features/errors/index';
import { Button } from '@/components/ui/primitives';

export function TargetPicker<T extends { readonly key: string }>({
  label,
  items,
  selectedKey,
  onSelect,
  isLoading,
  isError,
  error,
  onRecover,
  emptyMessage,
  renderItem,
  searchPlaceholder,
  onSearchChange,
  searchValue,
}: {
  readonly label: string;
  readonly items: readonly T[];
  readonly selectedKey: string | undefined;
  readonly onSelect: (item: T) => void;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly onRecover: () => void;
  readonly emptyMessage: string;
  readonly renderItem: (item: T) => ReactNode;
  readonly searchPlaceholder?: string | undefined;
  readonly onSearchChange?: ((value: string) => void) | undefined;
  readonly searchValue?: string | undefined;
}): ReactNode {
  const searchId = useId();
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        {isLoading ? <span className="text-sm text-[var(--muted)]">Loading…</span> : null}
      </div>
      {onSearchChange !== undefined ? (
        <input
          id={searchId}
          value={searchValue ?? ''}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder ?? 'Search…'}
          className="mb-3 min-h-11 w-full rounded-md border border-[var(--line)] bg-[var(--bg-elevated)] px-3"
        />
      ) : null}
      {isError ? (
        <ProblemAlert problem={classifyUiProblem(error)} onRecover={onRecover} />
      ) : null}
      {!isLoading && !isError && items.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">{emptyMessage}</p>
      ) : null}
      <ul className="max-h-72 space-y-2 overflow-y-auto">
        {items.map((item) => {
          const selected = item.key === selectedKey;
          return (
            <li key={item.key}>
              <button
                type="button"
                onClick={() => onSelect(item)}
                className={`w-full rounded-lg border px-4 py-3 text-left transition ${
                  selected
                    ? 'border-[var(--ink)] bg-[var(--bg-elevated)]'
                    : 'border-[var(--line)] hover:border-[var(--accent)]'
                }`}
              >
                {renderItem(item)}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function ManualEntryToggle({
  enabled,
  onToggle,
  children,
}: {
  readonly enabled: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="space-y-3">
      <Button type="button" tone="neutral" onClick={onToggle}>
        {enabled ? 'Use list instead' : 'Enter manually'}
      </Button>
      {enabled ? children : null}
    </div>
  );
}

export function useDebouncedSearch(initial = '', delayMs = 250): {
  readonly value: string;
  readonly debounced: string;
  readonly setValue: (value: string) => void;
} {
  const [value, setValue] = useState(initial);
  const [debounced, setDebounced] = useState(initial);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return { value, debounced, setValue };
}

export function useRepositoryPullRequests(
  repositoryId: string,
  query: string,
): {
  readonly pullRequests: UseQueryResult<readonly PullRequestSummary[]>;
} {
  const client = getApiClient();
  const pullRequests = useQuery<readonly PullRequestSummary[]>({
    queryKey: queryKeys.repositoryTargets.pullRequests(repositoryId, query),
    queryFn: ({ signal }) =>
      client.repositoryTargets.pullRequests(repositoryId, { signal }, { state: 'open', q: query, limit: 25 }),
  });
  return { pullRequests };
}

export function useRepositoryIssues(
  repositoryId: string,
  query: string,
): {
  readonly issues: UseQueryResult<readonly IssueSummary[]>;
} {
  const client = getApiClient();
  const issues = useQuery<readonly IssueSummary[]>({
    queryKey: queryKeys.repositoryTargets.issues(repositoryId, query),
    queryFn: ({ signal }) =>
      client.repositoryTargets.issues(repositoryId, { signal }, { state: 'open', q: query, limit: 25 }),
  });
  return { issues };
}

export function useRepositoryRefs(
  repositoryId: string,
  query: string,
): {
  readonly refs: UseQueryResult<readonly GitRefSummary[]>;
} {
  const client = getApiClient();
  const refs = useQuery<readonly GitRefSummary[]>({
    queryKey: queryKeys.repositoryTargets.refs(repositoryId, query),
    queryFn: ({ signal }) =>
      client.repositoryTargets.refs(repositoryId, { signal }, { q: query, limit: 25 }),
  });
  return { refs };
}

export function useRepositoryFindings(repositoryId: string): {
  readonly findings: UseQueryResult<readonly RepositoryFindingSummary[]>;
} {
  const client = getApiClient();
  const findings = useQuery<readonly RepositoryFindingSummary[]>({
    queryKey: queryKeys.repositoryTargets.findings(repositoryId),
    queryFn: ({ signal }) =>
      client.repositoryTargets.findings(repositoryId, { signal }, { status: 'open', limit: 25 }),
  });
  return { findings };
}
