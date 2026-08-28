/**
 * C005 — Authentication principals and ports.
 *
 * Identity is established here and consumed by C006 repository authorization.
 * The GitHub App installation is repository ACCESS, never a browser principal.
 */
import type { TimestampIso } from '@devguard/contracts';

/** How a principal authenticated. Session principals are browser cookie
 * sessions (CP003); API-token principals are CLI device/bearer credentials
 * (CP004). The GitHub App installation is never a principal (C005).
 */
export type AuthMethod = 'session' | 'api_token';

/** Authenticated principal bound to either a session or an API token. */
export interface Principal {
  readonly userId: string;
  readonly issuer: string;
  readonly providerSubject: string;
  /** Stable identity key above; presentation values below. */
  readonly providerLogin?: string | undefined;
  readonly providerDisplayName?: string | undefined;
  readonly authMethod: AuthMethod;
  /**
   * Reference of the hashed session id (never the raw token). Present only
   * when `authMethod === 'session'` (CP003).
   */
  readonly sessionIdHash?: string | undefined;
  /**
   * Reference of the hashed API token id (never the raw token). Present only
   * when `authMethod === 'api_token'` (CP004).
   */
  readonly tokenIdHash?: string | undefined;
  readonly authenticatedAt: TimestampIso;
}

export interface ExternalIdentity {
  readonly issuer: string;
  readonly providerSubject: string;
  readonly login: string;
  readonly displayName?: string;
}

export interface AuthSessionRecord {
  readonly sessionIdHash: string;
  readonly userId: string;
  readonly providerIssuer: string;
  readonly providerSubject: string;
  /** Display snapshot for safe session summaries; never an authorization input. */
  readonly providerLogin?: string | undefined;
  readonly providerDisplayName?: string | undefined;
  readonly createdAt: TimestampIso;
  readonly lastSeenAt: TimestampIso;
  readonly idleExpiresAt: TimestampIso;
  readonly absoluteExpiresAt: TimestampIso;
  readonly revokedAt?: TimestampIso | undefined;
  readonly rowVersion: number;
}

export interface AuthTransactionRecord {
  readonly stateHash: string;
  /**
   * PKCE verifier for the S256 challenge. It MUST be presented verbatim at
   * token exchange, so it is retained in the server-side single-use
   * transaction (10-minute TTL) rather than hashed. Encryption at rest is
   * upgraded by C093.
   */
  readonly pkceVerifier: string;
  readonly returnToPath: string;
  readonly createdAt: TimestampIso;
  readonly expiresAt: TimestampIso;
  readonly consumedAt?: TimestampIso | undefined;
  readonly rowVersion: number;
}

export interface SessionPolicyInput {
  readonly idleMinutes: number;
  readonly absoluteHours: number;
}

/** Durable session store port (PostgreSQL adapter arrives with C007/C009). */
export interface AuthSessionRepository {
  insert(record: AuthSessionRecord): Promise<void>;
  findBySessionIdHash(sessionIdHash: string): Promise<AuthSessionRecord | undefined>;
  /** CAS update; throws VERSION_CONFLICT when the record moved. */
  touch(
    sessionIdHash: string,
    lastSeenAt: TimestampIso,
    idleExpiresAt: TimestampIso,
    expectedRowVersion: number,
  ): Promise<void>;
  /** CAS revoke; revoking an already-revoked identical record is a no-op. */
  revoke(sessionIdHash: string, revokedAt: TimestampIso, expectedRowVersion: number): Promise<void>;
}

/** One-time OAuth transaction store port. */
export interface AuthTransactionRepository {
  insert(record: AuthTransactionRecord): Promise<void>;
  findByStateHash(stateHash: string): Promise<AuthTransactionRecord | undefined>;
  /** CAS consume; consuming a consumed/expired transaction conflicts. */
  consume(stateHash: string, consumedAt: TimestampIso, expectedRowVersion: number): Promise<void>;
}

/** Provider-neutral OIDC/OAuth client port (adapter: GitHub OAuth today). */
export interface IdentityProviderClient {
  buildAuthorizeUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
  }): string;
  exchangeCode(input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<{ readonly accessToken: string }>;
  fetchIdentity(accessToken: string): Promise<ExternalIdentity>;
}

/** Links a verified external identity to (or creates) a DevGuard user. */
export interface UserIdentityLinker {
  /** Returns the DevGuard userId for this issuer+subject pair. */
  resolve(
    issuer: string,
    providerSubject: string,
    profile: { login: string; displayName?: string },
  ): Promise<string>;
}

/**
 * Persisted API token row (CP004). Stores the SHA-256 HASH of the raw token
 * only; the plaintext is handed to the caller exactly once at issuance.
 */
export interface ApiTokenRecord {
  readonly tokenId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly label: string;
  readonly createdAt: TimestampIso;
  readonly lastUsedAt?: TimestampIso | undefined;
  readonly expiresAt: TimestampIso;
  readonly revokedAt?: TimestampIso | undefined;
  readonly rowVersion: number;
}

/** Durable CLI/API token store port (PostgreSQL adapter in @devguard/db). */
export interface ApiTokenRepository {
  insert(record: ApiTokenRecord): Promise<void>;
  /** Lookup by the SHA-256 hash used at authenticate time. */
  findByTokenHash(tokenHash: string): Promise<ApiTokenRecord | undefined>;
  /** Metadata for one owner's tokens, newest first (never includes hashes). */
  listByOwner(userId: string): Promise<readonly ApiTokenRecord[]>;
  /** Mark an owner's token revoked; unknown/other-owner is a no-op. */
  revoke(tokenId: string, userId: string, revokedAt: TimestampIso): Promise<void>;
}
