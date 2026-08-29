import type { OriginSurface, TriggerTypeV1 } from '@devguard/api-contracts';

/** Canonical query keys (C090). Always user-partitioned by the session query. */
export const queryKeys = {
  auth: {
    session: ['auth', 'session'] as const,
  },
  health: {
    live: ['health', 'live'] as const,
    ready: ['health', 'ready'] as const,
    preflight: ['health', 'preflight'] as const,
  },
  repositories: {
    navigation: ['repositories', { scope: 'navigation' }] as const,
    onboarding: ['repositories', { scope: 'onboarding' }] as const,
    detail: (repositoryId: string) => ['repository', repositoryId] as const,
    health: (repositoryId: string) => ['repository', repositoryId, 'health'] as const,
  },
  github: {
    installations: ['github', 'installations'] as const,
    installationRepositories: (installationId: string, query?: string) =>
      ['github', 'installationRepositories', installationId, { query: query ?? '' }] as const,
  },
  commands: {
    available: (repositoryId: string) => ['commands', repositoryId] as const,
  },
  workflows: {
    list: (
      repositoryId: string,
      filters: {
        readonly originSurface?: OriginSurface;
        readonly triggerType?: TriggerTypeV1;
        readonly pullRequestNumber?: number;
        readonly status?: string;
        readonly scope?: string;
      },
    ) => ['workflows', repositoryId, filters] as const,
    detail: (runId: string) => ['workflow', runId] as const,
  },
  session: {
    detail: (sessionId: string) => ['session', sessionId] as const,
    events: (sessionId: string) => ['sessionEvents', sessionId] as const,
  },
  approvals: {
    pendingNav: ['approvals', { status: 'pending', scope: 'navigation' }] as const,
    list: (filters: { readonly repositoryId?: string; readonly status?: string }) =>
      ['approvals', filters] as const,
    forRun: (runId: string) => ['approvals', 'run', runId] as const,
  },
  policy: {
    active: (repositoryId: string) => ['policy', repositoryId, 'active'] as const,
    history: (repositoryId: string) => ['policy', repositoryId, 'history'] as const,
  },
  artifacts: {
    forRun: (runId: string) => ['artifacts', runId] as const,
    detail: (artifactId: string) => ['artifact', artifactId] as const,
  },
  findings: {
    forRun: (runId: string) => ['securityFindings', runId] as const,
  },
  audit: {
    global: ['audit'] as const,
  },
} as const;
