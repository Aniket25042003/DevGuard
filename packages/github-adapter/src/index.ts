/**
 * @devguard/github-adapter — provider-isolating GitHub adapter (C017–C021).
 *
 * Boundary rules:
 * - Provider SDK/REST types never cross this boundary.
 * - Writes require an AuthorizedActionContext from the action gateway (C030).
 * - Tokens/keys never leave here except via SecretString (non-serializable).
 * - Read-only resource adapters (C019); writes arrive through C020/C021 later.
 */
export {
  CAPABILITY_PERMISSION_MAP,
  GITHUB_CAPABILITIES,
  SecretString,
  requiredPermissionsFor,
  scopeDigest,
  secretFrom,
  type GitHubCapability,
  type InstallationContext,
  type InstallationTokenLease,
} from './auth/contracts.js';
export {
  AppJwtSigner,
  InMemoryKeyProvider,
  type AppKeyMaterial,
  type AppJwtSignerOptions,
  type SecretKeyProvider,
  type SignedAppJwt,
} from './auth/app-jwt-signer.js';
export {
  InMemoryTokenLeaseCache,
  TokenLeaseManager,
  type InstallationTokenMintPort,
  type TokenLeaseCache,
} from './auth/token-lease-cache.js';

export type {
  AuthorizedActionContext,
  CallSafety,
  GitHubAdapterError,
  GitHubAdapterErrorKind,
  GitHubOperation,
  GitHubRateInfo,
  GitHubRequestContext,
  GitHubResponseMeta,
  GitHubResult,
  HttpMethod,
} from './core/contracts.js';

export {
  FetchTransport,
  GitHubBaseClient,
  type GitHubClientOptions,
  type GitHubTransport,
  type RawTransportResponse,
} from './core/client.js';

// ---- C019 read adapter ----
export {
  GITHUB_API_VERSION,
  OP_GET_FILE,
  OP_GET_ISSUE,
  OP_GET_REPOSITORY,
  OP_GET_TREE,
  OP_LIST_ISSUE_COMMENTS,
  OP_RESOLVE_REF,
  repoPath,
  sha40,
  type GitHubComment,
  type GitHubIssue,
  type GitHubRepository,
  type GitFile,
  type GitTreeEntry,
  type GitTreePage,
} from './read/operations.js';
export { GitHubReadAdapter, type ReadContext, type ReadResult } from './read/read-adapter.js';

// ---- C013 repository lifecycle ----
export {
  REPOSITORY_LIFECYCLE_STATUSES,
  RepositoryLifecycleService,
  type ConnectionResult,
  type ConnectedRepositoryRecord,
  type ConnectRepository,
  type DefaultPolicySeeder,
  type InstallationContextPort,
  type RepositoryLifecyclePersistencePort,
  type RepositoryLifecycleStatus,
} from './read/lifecycle.js';
