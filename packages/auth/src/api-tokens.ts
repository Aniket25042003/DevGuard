/**
 * CP004 — CLI/API bearer tokens.
 *
 * Tokens behave like sessions for the identity layer: full user API from the
 * same principal, hashes persisted only, expiry + revocation enforced at
 * authenticate time. The raw token is returned to the caller exactly once at
 * issuance; stores persist only its SHA-256 hash (domain-separated prefix) so
 * a stolen database can never authenticate (C005 "tokens hashed").
 *
 * Issuance requires an authenticated session (browser), not another API token,
 * to bound blast radius (§11). Authenticating with a token never touches the
 * session store — API tokens and sessions are independent credentials for the
 * same DevGuard user.
 */
import { randomUUID } from 'node:crypto';
import { validationFailed } from '@devguard/errors';
import type { TimestampIso } from '@devguard/contracts';
import type { ApiTokenRepository, Principal } from './principal.js';
import { generateApiToken, hashApiToken, hashToken, isApiTokenShape } from './tokens.js';

const DEFAULT_TOKEN_TTL_DAYS = 90;
const LABEL_MIN = 1;
const LABEL_MAX = 64;

export interface ApiTokenServiceDeps {
  readonly tokens: ApiTokenRepository;
  /** Presentation snapshot for the token principal's display fields. */
  readonly ownerProfile?: { readonly login: string; readonly displayName?: string } | undefined;
  readonly now: () => Date;
  /** Lifetime of an API token before expiry (re-issue to extend). Default 90d. */
  readonly tokenTtlDays?: number | undefined;
}

export interface IssuedApiToken {
  /** Raw plaintext token — shown exactly once. Never persisted server-side. */
  readonly token: string;
  readonly tokenId: string;
  readonly expiresAt: TimestampIso;
}

export interface ApiTokenSummary {
  readonly tokenId: string;
  readonly label: string;
  readonly createdAt: TimestampIso;
  readonly lastUsedAt?: TimestampIso | undefined;
  readonly expiresAt: TimestampIso;
  readonly revokedAt?: TimestampIso | undefined;
}

function iso(date: Date): TimestampIso {
  return date.toISOString() as TimestampIso;
}

/**
 * Validated label bound: non-empty, trim-normalized, ≤64 chars, no secret
 * material (charset restricted to printable, no control characters).
 */
export function normalizeTokenLabel(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw validationFailed([{ path: 'label', constraint: 'must be a string (1..64 chars)' }]);
  }
  const label = raw.trim();
  if (label.length < LABEL_MIN || label.length > LABEL_MAX) {
    throw validationFailed([{ path: 'label', constraint: `must be 1..${LABEL_MAX} characters` }]);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u0080-\u009f]/.test(label)) {
    throw validationFailed([{ path: 'label', constraint: 'must not contain control characters' }]);
  }
  return label;
}

export class ApiTokenService {
  private readonly tokenTtlMs: number;

  constructor(private readonly deps: ApiTokenServiceDeps) {
    this.tokenTtlMs = (deps.tokenTtlDays ?? DEFAULT_TOKEN_TTL_DAYS) * 24 * 3_600_000;
  }

  /** Issue a new token for an already-authenticated DevGuard user (§11). */
  async issue(input: {
    readonly ownerUserId: string;
    readonly label: string;
  }): Promise<IssuedApiToken> {
    const label = normalizeTokenLabel(input.label);
    const now = this.deps.now();
    const { plaintext, tokenHash } = generateApiToken();
    const tokenId = randomUUID();
    const expiresAt = new Date(now.getTime() + this.tokenTtlMs);

    await this.deps.tokens.insert({
      tokenId,
      userId: input.ownerUserId,
      tokenHash,
      label,
      createdAt: iso(now),
      expiresAt: iso(expiresAt),
      rowVersion: 0,
    });

    return { token: plaintext, tokenId, expiresAt: iso(expiresAt) };
  }

  /** Summary metadata for one owner (never includes hashes or plaintext). */
  async listByOwner(userId: string): Promise<readonly ApiTokenSummary[]> {
    const records = await this.deps.tokens.listByOwner(userId);
    return records.map((record) => ({
      tokenId: record.tokenId,
      label: record.label,
      createdAt: record.createdAt,
      ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
      expiresAt: record.expiresAt,
      ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    }));
  }

  /** Idempotent revocation of an owner's token; unknown/foreign is a no-op. */
  async revoke(tokenId: string, userId: string): Promise<void> {
    await this.deps.tokens.revoke(tokenId, userId, iso(this.deps.now()));
  }

  /**
   * Resolve a presented `Authorization: Bearer` value into a principal, or
   * `undefined` when it is unknown, malformed, expired, or revoked. Never
   * throws for a bad credential — the kernel maps undefined to 401. Non-DG
   * shapes short-circuit so arbitrary bearer material never hits the store.
   */
  async authenticate(bearerToken: string): Promise<Principal | undefined> {
    if (bearerToken.length === 0 || !isApiTokenShape(bearerToken)) return undefined;
    const tokenHash = hashApiToken(bearerToken);
    const record = await this.deps.tokens.findByTokenHash(tokenHash);
    if (record === undefined) return undefined;
    if (record.revokedAt !== undefined) return undefined;
    const now = this.deps.now();
    if (Date.parse(record.expiresAt) <= now.getTime()) return undefined;

    const profile = this.deps.ownerProfile;
    return {
      userId: record.userId,
      issuer: 'devguard',
      providerSubject: record.userId,
      ...(profile?.login !== undefined ? { providerLogin: profile.login } : {}),
      ...(profile?.displayName !== undefined ? { providerDisplayName: profile.displayName } : {}),
      authMethod: 'api_token',
      tokenIdHash: hashToken(record.tokenId),
      authenticatedAt: record.createdAt,
    };
  }
}
