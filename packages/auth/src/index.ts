/**
 * @devguard/auth — provider-neutral authentication (C005).
 *
 * Boundary rule: identity only. Repository authorization lives in
 * @devguard/authorization and runs AFTER a principal exists.
 */
export type {
  AuthSessionRecord,
  AuthSessionRepository,
  AuthTransactionRecord,
  AuthTransactionRepository,
  ExternalIdentity,
  IdentityProviderClient,
  Principal,
  SessionPolicyInput,
  UserIdentityLinker,
} from './principal.js';

export {
  AuthenticationService,
  type CompleteLoginInput,
  type CompleteLoginResult,
  type StartLoginResult,
} from './service.js';

export {
  GITHUB_ISSUER,
  GitHubOAuthClient,
  type GitHubOAuthClientOptions,
} from './github-oauth.client.js';

export {
  InMemoryAuthSessionRepository,
  InMemoryAuthTransactionRepository,
  VOLATILE_STORE_NAME,
} from './memory-store.js';

export {
  constantTimeEquals,
  deriveCsrfToken,
  generateOpaqueToken,
  hashToken,
  sha256Hex,
} from './tokens.js';
