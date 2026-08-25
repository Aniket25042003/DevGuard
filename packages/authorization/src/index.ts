/**
 * @devguard/authorization — repository-scoped authorization (C006).
 *
 * Boundary rule: invoked AFTER C005 identity, BEFORE any resource load or
 * mutation. Never trusts UI state, repository ids from clients, or provider
 * claims without a current check.
 */
export {
  RepositoryCapability,
  authorizationQuery,
  requiresFreshCheck,
  timestampIso,
} from './capabilities.js';
export type {
  AuthorizationEvidenceRecord,
  AuthorizationEvidencePort,
  AuthorizationQueryShape,
  AuthorizationSource,
  GitHubPermissionPort,
  LocalRepositoryAccessPort,
  NormalizedGitHubRole,
  PrincipalRef,
} from './capabilities.js';

export {
  RepositoryAuthorizationService,
  requireAllow,
  type AuthorizationResult,
  type AuthorizeOptions,
} from './service.js';
export type { AuthorizationServiceDeps } from './service.js';
