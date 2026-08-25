/**
 * C005 — Authentication principals and ports.
 *
 * Identity is established here and consumed by C006 repository authorization.
 * The GitHub App installation is repository ACCESS, never a browser principal.
 */
import type { TimestampIso } from '@devguard/contracts';

/** Authenticated principal bound to a server-side session. */
export interface Principal {
  readonly userId: string;
  readonly issuer: string;
  readonly providerSubject: string;
  /** Reference of the hashed session id (never the raw token). */
  readonly sessionIdHash: string;
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
  readonly pkceVerifierHash?: string | undefined;
  readonly nonceHash?: string | undefined;
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
    readonly nonce: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
  }): string;
  exchangeCode(input: {
    readonly code: string;
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
