'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, Card } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors';
import { parseGitHubInstallationRef } from '@/features/github/lib/parse-github-installation-ref';

/** Handles GitHub App setup URL redirects (`?installation_id=`). */
export function GitHubSetupPage(): ReactNode {
  const params = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const installationId = params.get('installation_id');
  const [manualInput, setManualInput] = useState(installationId ?? '');
  const parsedManualId = useMemo(() => parseGitHubInstallationRef(manualInput), [manualInput]);
  const autoStarted = useRef(false);
  const complete = useMutation({
    mutationFn: (id: string) =>
      getApiClient().github.completeInstallation(id, { signal: new AbortController().signal }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.github.installations });
      router.replace(buildAppHref({ name: 'githubSettings' }));
    },
  });

  useEffect(() => {
    if (
      installationId !== null &&
      parseGitHubInstallationRef(installationId) !== undefined &&
      !autoStarted.current &&
      !complete.isPending &&
      !complete.isSuccess
    ) {
      autoStarted.current = true;
      complete.mutate(parseGitHubInstallationRef(installationId)!);
    }
  }, [complete, installationId]);

  if (installationId !== null && complete.isPending) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <p role="status" className="text-[var(--muted)]">
          Linking GitHub App installation…
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-8">
      <Card className="p-8">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">
          Link GitHub App installation
        </h1>
        <p className="mt-2 text-[var(--muted)]">
          Paste your GitHub installation ID or the full settings URL from GitHub under Settings →
          Applications → Installed GitHub Apps → DevGuard AI Agent.
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="installation-id">
          Installation ID or URL
        </label>
        <input
          id="installation-id"
          className="mt-2 w-full rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-3"
          value={manualInput}
          onChange={(event) => setManualInput(event.target.value)}
          placeholder="157569422 or https://github.com/settings/installations/157569422"
        />
        {manualInput.trim().length > 0 && parsedManualId === undefined ? (
          <p className="mt-2 text-sm text-[var(--danger)]" role="alert">
            Enter a numeric installation ID or a GitHub settings URL that ends with{' '}
            <code className="rounded bg-[var(--bg-muted)] px-1 py-0.5">/installations/12345678</code>.
          </p>
        ) : parsedManualId !== undefined ? (
          <p className="mt-2 text-sm text-[var(--muted)]">
            Will link installation <span className="font-mono">{parsedManualId}</span>.
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            onClick={() => {
              if (parsedManualId !== undefined) {
                complete.mutate(parsedManualId);
              }
            }}
            disabled={parsedManualId === undefined || complete.isPending}
          >
            {complete.isPending ? 'Linking…' : 'Link installation'}
          </Button>
          <Button tone="neutral" href={buildAppHref({ name: 'githubSettings' })}>
            Back
          </Button>
        </div>
        {complete.isError ? (
          <div className="mt-4">
            <ProblemAlert problem={classifyUiProblem(complete.error)} />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
