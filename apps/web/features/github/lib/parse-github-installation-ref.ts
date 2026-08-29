/**
 * Extract a GitHub App installation id from pasted input (raw id or settings URL).
 */
export function parseGitHubInstallationRef(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d{1,20}$/.test(trimmed)) return trimmed;

  const fromQuery = trimmed.match(/[?&]installation_id=(\d{1,20})\b/i)?.[1];
  if (fromQuery !== undefined) return fromQuery;

  const fromPath = trimmed.match(/\/installations\/(\d{1,20})(?:\b|\/|\?|#)/i)?.[1];
  if (fromPath !== undefined) return fromPath;

  return undefined;
}
