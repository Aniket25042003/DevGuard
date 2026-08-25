/**
 * C005 — AuthenticationService: login transaction flow and session lifecycle.
 *
 * Invariants:
 * - Login transactions are single-use (CAS consume); replays conflict (409).
 * - Session ids rotate at login; stores persist hashes only.
 * - Idle + absolute expiry; touch is CAS-guarded and throttled by callers.
 * - Every failure maps to a stable registered error code without leaking
 *   provider payloads or session material.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  idempotencyKeyConflict,
  internalError,
  makeError,
  unauthenticated,
  versionConflict,
} from '@devguard/errors';
import type { TimestampIso } from '@devguard/contracts';
import type {
  AuthSessionRepository,
  AuthTransactionRepository,
  ExternalIdentity,
  IdentityProviderClient,
  Principal,
  SessionPolicyInput,
  UserIdentityLinker,
} from './principal.js';
import { generateOpaqueToken, hashToken } from './tokens.js';

const LOGIN_TRANSACTION_TTL_MS = 10 * 60_000;

export interface StartLoginResult {
  readonly stateToken: string;
  readonly authorizeUrl: string;
  readonly transactionExpiresAt: string;
}

export interface CompleteLoginInput {
  readonly code?: string;
  readonly stateToken?: string;
}

export interface CompleteLoginResult {
  readonly sessionToken: string;
  readonly sessionIdHash: string;
  readonly userId: string;
  readonly returnToPath: string;
  readonly expiresAt: string;
}

export interface AuthServiceDeps {
  readonly identityProvider: IdentityProviderClient;
  readonly transactions: AuthTransactionRepository;
  readonly sessions: AuthSessionRepository;
  readonly identities: UserIdentityLinker;
  readonly policy: SessionPolicyInput;
  readonly redirectUri: string;
  readonly now: () => Date;
}

function iso(date: Date): TimestampIso {
  return date.toISOString() as TimestampIso;
}

function safeReturnTo(raw: string | undefined): string {
  if (raw !== undefined && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) {
    return raw;
  }
  return '/';
}

export class AuthenticationService {
  constructor(private readonly deps: AuthServiceDeps) {}

  /**
   * Begin an authorization-code + PKCE flow. Each call creates a fresh
   * single-use transaction; abandoned transactions simply expire.
   */
  async startLogin(input: { readonly returnTo?: string }): Promise<StartLoginResult> {
    const now = this.deps.now();
    const stateToken = generateOpaqueToken();
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const nonce = generateOpaqueToken();

    await this.deps.transactions.insert({
      stateHash: hashToken(stateToken),
      pkceVerifierHash: sha256Hex(verifier),
      nonceHash: hashToken(nonce),
      returnToPath: safeReturnTo(input.returnTo),
      createdAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + LOGIN_TRANSACTION_TTL_MS)),
      rowVersion: 0,
    });

    const authorizeUrl = this.deps.identityProvider.buildAuthorizeUrl({
      state: stateToken,
      nonce,
      codeChallenge: challenge,
      redirectUri: this.deps.redirectUri,
    });

    return {
      stateToken,
      authorizeUrl,
      transactionExpiresAt: new Date(now.getTime() + LOGIN_TRANSACTION_TTL_MS).toISOString(),
    };
  }

  /**
   * Validate the provider callback and create a rotated session.
   * Replay or unknown state fails closed with stable errors.
   */
  async completeLogin(
    input: CompleteLoginInput,
    profileFetcher?: never,
  ): Promise<CompleteLoginResult> {
    void profileFetcher;
    const now = this.deps.now();
    if (input.stateToken === undefined || input.code === undefined) {
      throw unauthenticated(new Error('missing code/state'));
    }
    const stateHash = hashToken(input.stateToken);
    const transaction = await this.deps.transactions.findByStateHash(stateHash);
    if (transaction === undefined || Date.parse(transaction.expiresAt) < now.getTime()) {
      // Unknown/expired states are indistinguishable to callers (no oracle).
      throw unauthenticated(new Error('unknown_or_expired_state'));
    }
    if (transaction.consumedAt !== undefined) {
      // Replay: the transaction was already spent.
      throw idempotencyKeyConflict(new Error('transaction_replayed'));
    }

    // Single-use consumption happens BEFORE any provider exchange so replays
    // can neither mint sessions nor spend authorization codes.
    try {
      await this.deps.transactions.consume(stateHash, iso(now), transaction.rowVersion);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('VERSION_CONFLICT')) {
        throw idempotencyKeyConflict(error);
      }
      throw error;
    }

    let identity: ExternalIdentity;
    try {
      const { accessToken } = await this.deps.identityProvider.exchangeCode({
        code: input.code,
        redirectUri: this.deps.redirectUri,
      });
      identity = await this.deps.identityProvider.fetchIdentity(accessToken);
    } catch (error) {
      // Provider failures surface as dependency unavailable; detail stays internal.
      throw makeError('DEPENDENCY_UNAVAILABLE', { cause: error });
    }

    const userId = await this.deps.identities.resolve(identity.issuer, identity.providerSubject, {
      login: identity.login,
      ...(identity.displayName !== undefined ? { displayName: identity.displayName } : {}),
    });

    // Fresh opaque session token; only its hash is persisted (rotation on login).
    const sessionToken = generateOpaqueToken();
    const sessionIdHash = hashToken(sessionToken);
    const absoluteExpiresAt = new Date(now.getTime() + this.deps.policy.absoluteHours * 3_600_000);
    const idleExpiresAt = new Date(now.getTime() + this.deps.policy.idleMinutes * 60_000);

    await this.deps.sessions.insert({
      sessionIdHash,
      userId,
      providerIssuer: identity.issuer,
      providerSubject: identity.providerSubject,
      providerLogin: identity.login,
      ...(identity.displayName !== undefined ? { providerDisplayName: identity.displayName } : {}),
      createdAt: iso(now),
      lastSeenAt: iso(now),
      idleExpiresAt: iso(idleExpiresAt),
      absoluteExpiresAt: iso(absoluteExpiresAt),
      rowVersion: 0,
    });

    return {
      sessionToken,
      sessionIdHash,
      userId,
      returnToPath: safeReturnTo(transaction.returnToPath),
      expiresAt: iso(absoluteExpiresAt),
    };
  }

  /**
   * Idempotent logout semantics: a presented token mapping to an existing
   * (even already-revoked) session yields success; unknown tokens throw 401.
   */
  async revokeIfExists(sessionToken: string): Promise<boolean> {
    const sessionIdHash = hashToken(sessionToken);
    const record = await this.deps.sessions.findBySessionIdHash(sessionIdHash);
    if (record === undefined) {
      throw unauthenticated(new Error('session_not_found'));
    }
    if (record.revokedAt !== undefined) return false;
    try {
      await this.deps.sessions.revoke(sessionIdHash, iso(this.deps.now()), record.rowVersion);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('VERSION_CONFLICT')) {
        // Concurrent revoke achieved the same outcome.
        return false;
      }
      throw internalError(error);
    }
  }

  /** Resolve a presented cookie token into a principal, enforcing expiry. */
  async resolvePrincipal(sessionToken: string | undefined): Promise<Principal | undefined> {
    if (sessionToken === undefined || sessionToken.length < 20) return undefined;
    const sessionIdHash = hashToken(sessionToken);
    const record = await this.deps.sessions.findBySessionIdHash(sessionIdHash);
    if (record === undefined) return undefined;
    const now = this.deps.now();
    if (
      record.revokedAt !== undefined ||
      Date.parse(record.idleExpiresAt) < now.getTime() ||
      Date.parse(record.absoluteExpiresAt) < now.getTime()
    ) {
      return undefined;
    }
    return {
      userId: record.userId,
      issuer: record.providerIssuer,
      providerSubject: record.providerSubject,
      sessionIdHash,
      authenticatedAt: record.createdAt,
    };
  }

  /** Idempotent revocation: same session again still yields success. */
  async revokeSession(sessionToken: string): Promise<void> {
    const sessionIdHash = hashToken(sessionToken);
    const record = await this.deps.sessions.findBySessionIdHash(sessionIdHash);
    if (record === undefined) {
      throw unauthenticated(new Error('session_not_found'));
    }
    if (record.revokedAt !== undefined) return;
    try {
      await this.deps.sessions.revoke(sessionIdHash, iso(this.deps.now()), record.rowVersion);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('VERSION_CONFLICT')) {
        const current = await this.deps.sessions.findBySessionIdHash(sessionIdHash);
        throw versionConflict(record.rowVersion, current?.rowVersion ?? -1, error);
      }
      throw internalError(error);
    }
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
