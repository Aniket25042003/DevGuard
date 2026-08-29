'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/server-state/query-keys';
import { Button, Card } from '@/components/ui/primitives';
import { buildAppHref } from '@/features/navigation/routes';
import { ProblemAlert, classifyUiProblem } from '@/features/errors';

/** Handles GitHub App setup URL redirects (`?installation_id=`). */
export function GitHubSetupPage(): ReactNode {
  const params = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const installationId = params.get('installation_id');
  const [manualId, setManualId] = useState(installationId ?? '');
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
      /^\d+$/.test(installationId) &&
      !autoStarted.current &&
      !complete.isPending &&
      !complete.isSuccess
    ) {
      autoStarted.current = true;
      complete.mutate(installationId);
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
          If you installed the DevGuard GitHub App outside this flow, paste your GitHub installation
          ID here. You can find it in GitHub under Settings → Applications → Installed GitHub Apps.
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="installation-id">
          Installation ID
        </label>
        <input
          id="installation-id"
          className="mt-2 w-full rounded-xl border border-[var(--line)] bg-[var(--bg-elevated)] px-4 py-3"
          inputMode="numeric"
          pattern="[0-9]*"
          value={manualId}
          onChange={(event) => setManualId(event.target.value)}
          placeholder="e.g. 12345678"
        />
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            onClick={() => complete.mutate(manualId)}
            disabled={!/^\d+$/.test(manualId) || complete.isPending}
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
