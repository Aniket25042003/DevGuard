/**
 * C017 §9/§19/§20 — scoped single-flight token lease cache.
 *
 * Cache keys are (installationId, scopeDigest, credentialVersion) so tokens
 * for different installations/repositories/permission sets NEVER coalesce.
 * Minting is single-flight per exact scope. A confirmed 401 invalidates the
 * matching lease exactly once; retry happens only after a remint.
 */
import type { InstallationTokenLease, SecretString } from './contracts.js';
import { scopeDigest } from './contracts.js';

export interface TokenLeaseCacheEntry {
  readonly lease: InstallationTokenLease;
  /** Monotonic cache-local timestamp for refresh scheduling. */
  readonly mintedAtMs: number;
  readonly refreshAtMs: number;
}

export interface TokenLeaseCache {
  get(key: string): TokenLeaseCacheEntry | undefined;
  set(key: string, entry: TokenLeaseCacheEntry): void;
  invalidate(key: string): void;
  invalidateAll(): void;
  size(): number;
}

export class InMemoryTokenLeaseCache implements TokenLeaseCache {
  #entries = new Map<string, TokenLeaseCacheEntry>();

  get(key: string): TokenLeaseCacheEntry | undefined {
    return this.#entries.get(key);
  }

  set(key: string, entry: TokenLeaseCacheEntry): void {
    this.#entries.set(key, entry);
  }

  invalidate(key: string): void {
    this.#entries.delete(key);
  }

  invalidateAll(): void {
    this.#entries.clear();
  }

  size(): number {
    return this.#entries.size;
  }
}

/** Opaque port that acquires a fresh installation token from GitHub. */
export interface InstallationTokenMintPort {
  mint(input: {
    installationId: string;
    githubRepositoryIds: readonly string[];
    capabilities: readonly string[];
  }): Promise<{ token: SecretString; expiresAtIso: string }>;
}

export class TokenLeaseManager {
  #inFlight = new Map<string, Promise<InstallationTokenLease>>();

  constructor(
    private readonly cache: TokenLeaseCache,
    private readonly mintPort: InstallationTokenMintPort,
    private readonly nowMs: () => number,
    /** Refresh when lease is within this window of expiry (skew margin). */
    private readonly refreshSkewMs = 60_000,
  ) {}

  /**
   * Get a valid lease or mint a fresh one (single-flight per scope key).
   * Uses the caller-supplied uniqueKey to distinguish different scopes.
   */
  async acquire(
    _uniqueKey: string,
    installationId: string,
    githubRepositoryIds: readonly string[],
    capabilities: readonly string[],
    credentialVersion: string,
  ): Promise<InstallationTokenLease> {
    const digest = scopeDigest(githubRepositoryIds, capabilities as never);
    const cacheKey = `${installationId}|${digest}|${credentialVersion}`;

    const existing = this.cache.get(cacheKey);
    if (existing && existing.refreshAtMs > this.nowMs()) {
      return existing.lease;
    }

    // Single-flight: reuse the in-flight promise for the same scope key.
    const inFlight = this.#inFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const mintPromise = this.#mint(
      cacheKey,
      installationId,
      githubRepositoryIds,
      capabilities,
      credentialVersion,
    );
    this.#inFlight.set(cacheKey, mintPromise);
    try {
      return await mintPromise;
    } finally {
      this.#inFlight.delete(cacheKey);
    }
  }

  async #mint(
    cacheKey: string,
    installationId: string,
    githubRepositoryIds: readonly string[],
    capabilities: readonly string[],
    credentialVersion: string,
  ): Promise<InstallationTokenLease> {
    const result = await this.mintPort.mint({
      installationId,
      githubRepositoryIds,
      capabilities,
    });
    const expiresAtMs = Date.parse(result.expiresAtIso);
    const refreshAtMs = expiresAtMs - this.refreshSkewMs;
    const digest = scopeDigest(githubRepositoryIds, capabilities as never);
    const lease: InstallationTokenLease = {
      token: result.token,
      expiresAtIso: result.expiresAtIso,
      refreshAtIso: new Date(refreshAtMs).toISOString(),
      installationId,
      scopeDigest: digest,
      credentialVersion,
    };
    const now = this.nowMs();
    this.cache.set(cacheKey, {
      lease,
      mintedAtMs: now,
      refreshAtMs,
    });
    return lease;
  }

  /** Confirmed 401: invalidate the matching lease exactly once. */
  invalidate(
    _uniqueKey: string,
    installationId: string,
    githubRepositoryIds: readonly string[],
    capabilities: readonly string[],
    credentialVersion: string,
  ): void {
    const digest = scopeDigest(githubRepositoryIds, capabilities as never);
    this.cache.invalidate(`${installationId}|${digest}|${credentialVersion}`);
  }

  invalidateAll(): void {
    this.cache.invalidateAll();
  }
}
