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
