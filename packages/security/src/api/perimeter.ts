/**
 * C094 — Perimeter primitives: exact CORS policy, session-bound CSRF with
 * Origin/Fetch-Metadata validation, and endpoint-class rate-limit policies.
 *
 * Invariants:
 * - CORS defaults deny; only exact normalized allowlisted origins match.
 *   Wildcard origin combined with credentials is unrepresentable.
 * - Cookie-authenticated mutations require BOTH a constant-time CSRF token
 *   pair AND an approved Origin/Fetch-Metadata signal.
 * - Rate keys are hierarchical and pseudonymous; limiter outages fail closed
 *   for high-risk classes instead of failing open.
 */
import { timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Origin/CORS
// ---------------------------------------------------------------------------

export interface CorsDecision {
  readonly allowed: boolean;
  readonly varyOrigin: boolean;
  readonly maxAgeSeconds: number;
}

function normalizeOrigin(raw: string): string {
  try {
    const parsed = new URL(raw);
    // A true origin is ONLY scheme://host[:port] — anything carrying userinfo,
    // a path beyond '/', search, or hash is not an Origin value.
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      (parsed.pathname !== '/' && parsed.pathname !== '') ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return '';
    }
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return '';
  }
}

export class OriginPolicy {
  private readonly allowed: ReadonlySet<string>;

  constructor(allowedOrigins: readonly string[]) {
    this.allowed = new Set(
      allowedOrigins.map(normalizeOrigin).filter((origin) => origin.length > 0),
    );
  }

  isAllowed(originHeader: string | undefined): boolean {
    if (originHeader === undefined || originHeader === '' || originHeader === 'null') {
      return false;
    }
    const normalized = normalizeOrigin(originHeader);
    if (normalized.length === 0) return false;
    // Reject reflected/suffix tricks by requiring full-set membership.
    for (const allowed of this.allowed) {
      if (normalized === allowed) return true;
    }
    return false;
  }

  evaluateCors(originHeader: string | undefined): CorsDecision {
    const allowed = this.isAllowed(originHeader);
    return { allowed, varyOrigin: true, maxAgeSeconds: allowed ? 600 : 0 };
  }
}

// ---------------------------------------------------------------------------
// Fetch Metadata / same-origin signals
// ---------------------------------------------------------------------------

export type FetchMetadataSite = 'same-origin' | 'same-site' | 'cross-site' | 'none';

export function fetchMetadataSite(headerValue: string | undefined): FetchMetadataSite {
  switch (headerValue) {
    case 'same-origin':
      return 'same-origin';
    case 'same-site':
      return 'same-site';
    case 'none':
      return 'none';
    case 'cross-site':
      return 'cross-site';
    default:
      return 'none'; // absent header → treat conservatively as 'none'
  }
}

export interface CsrfVerificationInput {
  readonly method: string;
  readonly cookieToken: string | undefined;
  readonly headerToken: string | undefined;
  readonly origin: string | undefined;
  readonly secFetchSite: FetchMetadataSite;
  readonly publicOrigin: string | undefined;
  /** Bearer-authenticated non-browser calls are exempt from the cookie pair. */
  readonly bearerAuthenticated: boolean;
  readonly webhookPath: boolean;
}

export interface CsrfDecision {
  readonly allowed: boolean;
  readonly reasonCode?:
    'csrf_pair_missing' | 'csrf_pair_mismatch' | 'origin_disallowed' | 'cross_site_blocked';
}

function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Mutating, cookie-carrying browser requests must pass all three defenses. */
export function verifyCsrf(input: CsrfVerificationInput): CsrfDecision {
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(input.method.toUpperCase());
  if (!mutating) return { allowed: true };
  if (input.webhookPath) return { allowed: true }; // HMAC-protected separately
  if (input.bearerAuthenticated && input.cookieToken === undefined) {
    // Non-browser API call: no ambient cookies involved.
    return { allowed: true };
  }

  // Triple defense is mandatory for cookie-authenticated mutations: an
  // approved Origin is REQUIRED (absent/stripped headers fail closed), and
  // Fetch-Metadata must corroborate same-origin/same-site.
  if (input.secFetchSite === 'cross-site' || input.secFetchSite === 'none') {
    return { allowed: false, reasonCode: 'cross_site_blocked' };
  }

  if (input.publicOrigin !== undefined) {
    if (input.origin === undefined) {
      return { allowed: false, reasonCode: 'origin_disallowed' };
    }
    const policy = new OriginPolicy([input.publicOrigin]);
    if (!policy.isAllowed(input.origin)) {
      return { allowed: false, reasonCode: 'origin_disallowed' };
    }
  }

  if (input.cookieToken === undefined || input.headerToken === undefined) {
    return { allowed: false, reasonCode: 'csrf_pair_missing' };
  }
  if (!safeEquals(input.cookieToken, input.headerToken)) {
    return { allowed: false, reasonCode: 'csrf_pair_mismatch' };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Rate-limit policies (endpoint classes)
// ---------------------------------------------------------------------------

export type RatePolicyClass =
  | 'auth_login'
  | 'auth_callback'
  | 'auth_logout'
  | 'webhook_ingress'
  | 'approval_resolve'
  | 'workflow_start'
  | 'workflow_cancel'
  | 'artifact_download'
  | 'expensive_diagnostics'
  | 'default';

export interface RatePolicy {
  readonly limit: number;
  readonly windowSeconds: number;
  /** High-risk classes fail CLOSED when the distributed limiter is down. */
  readonly failClosedOnOutage: boolean;
}

export const RATE_POLICIES: Readonly<Record<RatePolicyClass, RatePolicy>> = Object.freeze({
  auth_login: { limit: 10, windowSeconds: 60, failClosedOnOutage: true },
  auth_callback: { limit: 30, windowSeconds: 60, failClosedOnOutage: true },
  auth_logout: { limit: 15, windowSeconds: 60, failClosedOnOutage: false },
  webhook_ingress: { limit: 600, windowSeconds: 60, failClosedOnOutage: false },
  approval_resolve: { limit: 20, windowSeconds: 60, failClosedOnOutage: true },
  workflow_start: { limit: 30, windowSeconds: 60, failClosedOnOutage: true },
  workflow_cancel: { limit: 30, windowSeconds: 60, failClosedOnOutage: true },
  artifact_download: { limit: 60, windowSeconds: 60, failClosedOnOutage: false },
  expensive_diagnostics: { limit: 5, windowSeconds: 60, failClosedOnOutage: false },
  default: { limit: 300, windowSeconds: 60, failClosedOnOutage: false },
});

/** Hierarchical key: class + pseudonymous actor/source/repo components. */
export function hierarchicalRateKey(
  policyClass: RatePolicyClass,
  components: ReadonlyArray<string | undefined>,
): string {
  const hashed = components.map((component) => {
    if (component === undefined || component.length === 0) return '-';
    return createHash('sha256').update(component).digest('hex').slice(0, 16);
  });
  return `${policyClass}:${hashed.join(':')}`;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly remaining: number;
  /** Set when refusal came from outage fail-closed rather than count. */
  readonly failClosed?: boolean | undefined;
}

export interface DistributedRateLimiterPort {
  /**
   * Atomic consume against a distributed counter.
   * Implementations MUST be atomic (Redis INCR/EXPIRE script).
   * Throws on infrastructure outage — callers consult policy.failClosedOnOutage.
   */
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
}

/**
 * Outage-safe wrapper: converts limiter exceptions into conservative decisions
 * according to the class policy (fail closed for high-risk mutations).
 */
export class FailClosedRateLimiter {
  constructor(private readonly inner: DistributedRateLimiterPort) {}

  async consume(
    policyClass: RatePolicyClass,
    keySuffixComponents: ReadonlyArray<string | undefined>,
  ): Promise<RateLimitDecision> {
    const policy = RATE_POLICIES[policyClass];
    const key = hierarchicalRateKey(policyClass, keySuffixComponents);
    try {
      const decision = await this.inner.consume(key, policy.limit, policy.windowSeconds);
      return decision;
    } catch {
      if (policy.failClosedOnOutage) {
        return {
          allowed: false,
          retryAfterSeconds: policy.windowSeconds,
          remaining: 0,
          failClosed: true,
        };
      }
      // Low-risk classes degrade to allowed with a short client hint.
      return { allowed: true, retryAfterSeconds: 0, remaining: policy.limit, failClosed: true };
    }
  }
}
