export type AppRoute =
  | { readonly name: 'home' }
  | { readonly name: 'signIn'; readonly returnTo?: string }
  | { readonly name: 'callback' }
  | { readonly name: 'repositories' }
  | { readonly name: 'connectRepository' }
  | { readonly name: 'githubSettings' }
  | { readonly name: 'approvals' }
  | { readonly name: 'preflight' }
  | { readonly name: 'repository'; readonly repositoryId: string }
  | { readonly name: 'launcher'; readonly repositoryId: string }
  | { readonly name: 'run'; readonly repositoryId: string; readonly runId: string }
  | { readonly name: 'policy'; readonly repositoryId: string }
  | { readonly name: 'policyHistory'; readonly repositoryId: string };

export function buildAppHref(route: AppRoute): string {
  switch (route.name) {
    case 'home':
      return '/';
    case 'signIn':
      return route.returnTo !== undefined
        ? `/sign-in?returnTo=${encodeURIComponent(route.returnTo)}`
        : '/sign-in';
    case 'callback':
      return '/auth/callback';
    case 'repositories':
      return '/repositories';
    case 'connectRepository':
      return '/repositories/connect';
    case 'githubSettings':
      return '/settings/github';
    case 'approvals':
      return '/approvals';
    case 'preflight':
      return '/diagnostics/preflight';
    case 'repository':
      return `/repositories/${encodeURIComponent(route.repositoryId)}`;
    case 'launcher':
      return `/repositories/${encodeURIComponent(route.repositoryId)}/workflows/new`;
    case 'run':
      return `/repositories/${encodeURIComponent(route.repositoryId)}/workflows/${encodeURIComponent(route.runId)}`;
    case 'policy':
      return `/repositories/${encodeURIComponent(route.repositoryId)}/policy`;
    case 'policyHistory':
      return `/repositories/${encodeURIComponent(route.repositoryId)}/policy/history`;
  }
}

export function parseRepositoryId(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}
