/**
 * C036 — bounded secret/content redaction for the provider boundary.
 *
 * Provider raw payloads, error bodies, and fixtures must never carry secrets
 * into logs, model context, persistence, or UI. This module recursively walks
 * bounded object shapes and replaces any value whose key matches a secret
 * fingerprint. Depth/size are bounded; unknown or path-like values are not
 * invented into messages.
 */
const SECRET_KEY_PATTERN =
  /authorization|proxy-authorization|cookie|set-cookie|password|passwd|client[-_ .]?secret|access[-_ .]?token|refresh[-_ .]?token|auth[-_ .]?token|api[-_ .]?key|x[-_ .]?api[-_ .]?key|private[-_ .]?key|signature|integrity|credentials|secret|token/i;

export const REDACTION_MASK = '[REDACTED]';

/**
 * Strip secret-bearing inline assignments from free text (e.g. error strings),
 * e.g. `access_token="abc123"` or `Bearer token: xyz`. Over-redaction toward
 * safety is intentional: any key whose name looks secret is scrubbed rather
 * than risk leaking a value.
 */
export function redactInlineSecrets(input: string): string {
  return input.replace(
    /(?:authorization|proxy-authorization|cookie|client[-_ .]?secret|access[-_ .]?token|refresh[-_ .]?token|auth[-_ .]?token|api[-_ .]?key|x[-_ .]?api[-_ .]?key|private[-_ .]?key|password|passwd|secret|token|signature|integrity|credentials)\s*[:=]\s*["']?[^"'\r\n,;&]+/gi,
    (_match: string, key: string) => `${key} ${REDACTION_MASK}`,
  );
}

/**
 * Recursively redact secret-bearing keys. Preserves structural shape but caps
 * nesting depth and total walked nodes so hostile payloads cannot exhaust the
 * process. Matching key names always redact regardless of value type.
 */
export function redactProviderPayload(
  value: unknown,
  depth = 0,
  budget = { remaining: 400 },
): unknown {
  if (depth > 8 || budget.remaining <= 0) {
    return REDACTION_MASK;
  }
  // Scalar values are returned only if the caller decided the key was safe;
  // keys are matched by the parent (below), so a bare scalar here is safe.
  if (typeof value !== 'object' || value === null) {
    budget.remaining -= 1;
    return value;
  }
  if (Array.isArray(value)) {
    budget.remaining -= 1;
    return value.map((item) => redactProviderPayload(item, depth + 1, budget));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTION_MASK;
      budget.remaining -= 1;
      continue;
    }
    out[key] = redactProviderPayload(child, depth + 1, budget);
  }
  return out;
}

export { SECRET_KEY_PATTERN };
