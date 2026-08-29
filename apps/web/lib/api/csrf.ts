/** Double-submit CSRF: readable `devguard_csrf` cookie paired with `x-csrf-token`. */

export const CSRF_COOKIE = 'devguard_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function readCookie(name: string, cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined || cookieHeader === '') return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (key === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return undefined;
}

export function readCsrfToken(getCookieHeader: () => string | undefined): string | undefined {
  return readCookie(CSRF_COOKIE, getCookieHeader());
}
