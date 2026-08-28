/**
 * C036 §12/§15 — provider payload validation, normalization, and error
 * classification at the adapter boundary.
 *
 * The provider client returns raw payloads; every one is validated against a
 * pinned schema and normalized to neutral shapes before it can influence any
 * DevGuard decision. Unknown payloads reject (`AGENT_RESPONSE_SCHEMA_REJECTED`)
 * and the affected operation pauses/reconciles — they never default-allow.
 * Raw payloads are redacted before they can be logged or persisted.
 */
import { z } from 'zod';
import { redactInlineSecrets } from './redact.js';
import { isKnownProvider } from './contracts.js';

/** Raw identification report the provider returns for `identify()`. */
export const identificationReportSchema = z
  .object({
    provider: z.string().min(1).max(64),
    serverVersion: z.string().min(1).max(128),
    sdkPackage: z.string().min(1).max(128).optional(),
    sdkVersion: z.string().min(1).max(128).optional(),
    sdkIntegrity: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    authMode: z.enum(['server_secret', 'oauth', 'mtls']).optional(),
    topology: z.enum(['hosted', 'local', 'shared']).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Raw result of one verification probe. */
export const probeResultSchema = z
  .object({
    ok: z.boolean(),
    verifiedCapabilities: z.array(z.string().min(1).max(64)).default([]),
    detail: z.string().max(400).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export interface NormalizedProviderIdentification {
  readonly endpointIdentity: string;
  readonly provider: string;
  readonly serverVersion: string;
  readonly sdkPackage?: string | undefined;
  readonly sdkVersion?: string | undefined;
  readonly sdkIntegrity?: string | undefined;
  readonly authMode?: 'server_secret' | 'oauth' | 'mtls' | undefined;
  readonly topology?: 'hosted' | 'local' | 'shared' | undefined;
}

export interface NormalizedProbeResult {
  readonly probeOk: boolean;
  readonly verifiedCapabilities: readonly string[];
  readonly detailSanitized: string;
}

export interface ProviderErrorClassification {
  readonly code:
    | 'AGENT_AUTH_DENIED'
    | 'PROVIDER_RATE_LIMITED'
    | 'PROVIDER_UNAVAILABLE'
    | 'AGENT_RESPONSE_SCHEMA_REJECTED'
    | 'DEPENDENCY_UNAVAILABLE';
  readonly retryClass: 'safe_retry' | 'reconcile_then_retry' | 'no_retry' | 'human_intervention';
  readonly causeSanitized: string;
}

/**
 * Validate a raw probe payload against the pinned schema and normalize it.
 * Rejects unknown shapes; sanitizes only bounded, non-injectable detail.
 */
export function normalizeProbeResult(raw: unknown): NormalizedProbeResult {
  const parsed = probeResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('AGENT_RESPONSE_SCHEMA_REJECTED:probe result violated pinned contract schema');
  }
  const value = parsed.data;
  const verifiedCapabilities = value.verifiedCapabilities.filter(
    (name) => name.length <= 64 && /^[a-z][a-z0-9_]*$/.test(name),
  );
  const detailSanitized = (value.detail ?? '').slice(0, 400);
  return { probeOk: value.ok, verifiedCapabilities, detailSanitized };
}

/** Validate a raw identification payload. Unknown shapes throw. */
export function normalizeIdentification(
  raw: unknown,
  endpointIdentity: string,
  expectedProvider?: string,
): NormalizedProviderIdentification {
  const parsed = identificationReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'AGENT_RESPONSE_SCHEMA_REJECTED:identification violated pinned contract schema',
    );
  }
  const value = parsed.data;
  if (!isKnownProvider(value.provider)) {
    throw new Error('AGENT_RESPONSE_SCHEMA_REJECTED:unsupported provider');
  }
  if (expectedProvider !== undefined && value.provider !== expectedProvider) {
    throw new Error(`AGENT_RESPONSE_SCHEMA_REJECTED:provider mismatch (${value.provider})`);
  }
  return {
    endpointIdentity,
    provider: value.provider,
    serverVersion: value.serverVersion,
    sdkPackage: value.sdkPackage,
    sdkVersion: value.sdkVersion,
    sdkIntegrity: value.sdkIntegrity,
    authMode: value.authMode,
    topology: value.topology,
  };
}

/**
 * Classify a thrown provider error into a DevGuard code + retry class. Never
 * blind-retries: uncertain outcomes map to reconcile_then_retry; auth denies map
 * to AGENT_AUTH_DENIED (no_retry). Raw error text is never surfaced verbatim.
 */
export function classifyProviderError(err: unknown): ProviderErrorClassification {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  // Redact secret-bearing inline assignments (key="value") before any value can
  // be surfaced; never surface raw error text verbatim beyond a bounded prefix.
  const text = redactInlineSecrets(raw).slice(0, 200);
  const lower = raw.toLowerCase();

  if (/401|403|unauthori|forbidden|denied/.test(lower)) {
    return { code: 'AGENT_AUTH_DENIED', retryClass: 'no_retry', causeSanitized: text };
  }
  if (/429|rate.?limit|too many requests/.test(lower)) {
    return {
      code: 'PROVIDER_RATE_LIMITED',
      retryClass: 'reconcile_then_retry',
      causeSanitized: text,
    };
  }
  if (/schema|contract|unexpected|unknown field|validation failed/.test(lower)) {
    return {
      code: 'AGENT_RESPONSE_SCHEMA_REJECTED',
      retryClass: 'reconcile_then_retry',
      causeSanitized: text,
    };
  }
  if (/econnreset|timeout|timed out|unavailable|network|dns/i.test(lower)) {
    return { code: 'PROVIDER_UNAVAILABLE', retryClass: 'safe_retry', causeSanitized: text };
  }
  return {
    code: 'DEPENDENCY_UNAVAILABLE',
    retryClass: 'reconcile_then_retry',
    causeSanitized: text,
  };
}
