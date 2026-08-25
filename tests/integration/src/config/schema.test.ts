import { describe, expect, it } from 'vitest';
import { loadConfig, safeSummary, scanForUnknownVariables } from '@devguard/config';
import { configurationInvalid, DevGuardError } from '@devguard/errors';

const BASE_ENV = {
  DEVGUARD_ENV: 'test',
  DATABASE_URL: 'postgres://secret-value',
  REDIS_URL: 'redis://secret-value',
  AUTH_MODE: 'github_oauth',
  AUTH_SESSION_SECRET: 'session-secret-value',
  AUTH_GITHUB_OAUTH_CLIENT_ID: 'client-id-123',
  AUTH_GITHUB_OAUTH_CLIENT_SECRET: 'client-secret-value',
  AUTH_GITHUB_OAUTH_CALLBACK_URL: 'http://localhost:3000/callback',
  DEVGUARD_PUBLIC_ORIGIN: 'http://localhost:3000',
} as const;

describe('C002 process schemas', () => {
  it('loads a valid api snapshot with frozen values', async () => {
    const config = await Promise.resolve(loadConfig('api', { env: { ...BASE_ENV } }));
    expect(config.processKind).toBe('api');
    expect(config.environment).toBe('test');
    expect(config.limits.webhookMaxBodyBytes).toBe(1_048_576);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen((config as { features: object }).features)).toBe(true);
  });

  it('fails fast when required fields are missing, without echoing values', () => {
    let caught: unknown;
    try {
      loadConfig('api', { env: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DevGuardError);
    const devGuardError = caught as DevGuardError;
    expect(devGuardError.code).toBe('CONFIGURATION_INVALID');
    const issues = devGuardError.safeDetails as Array<{ path: string }>;
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('DEVGUARD_ENV');
    expect(paths).toContain('DATABASE_URL');
    expect(JSON.stringify(issues)).not.toContain('postgres://');
  });

  it('throws the typed CONFIGURATION_INVALID error for schema violations', () => {
    let code: string | undefined;
    try {
      loadConfig('api', {
        env: { ...BASE_ENV, DEVGUARD_TRUEFORGE_TIMEOUT_MS: 'not-a-number' },
      });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('CONFIGURATION_INVALID');
  });

  it('requires github_oauth fields together and forbids none-mode in production', async () => {
    const partial = loadConfigFailing({
      ...BASE_ENV,
      AUTH_SESSION_SECRET: undefined,
    });
    expect(partial.some((i) => i.path === 'AUTH_SESSION_SECRET')).toBe(true);

    const prodNone = loadConfigFailing({
      ...BASE_ENV,
      DEVGUARD_ENV: 'production',
      AUTH_MODE: 'none',
    });
    expect(prodNone.some((i) => i.path === 'AUTH_MODE')).toBe(true);

    // Explicit none mode is fine in development.
    const devSnapshot = loadConfig('api', {
      env: { ...BASE_ENV, DEVGUARD_ENV: 'development', AUTH_MODE: 'none' },
    });
    expect(devSnapshot.auth.mode).toBe('none');
  });

  it('validates URLs, enums, and integer ranges with path-only issues', async () => {
    const issues = loadConfigFailing({
      ...BASE_ENV,
      DEVGUARD_LOG_LEVEL: 'verbose',
      DEVGUARD_WEBHOOK_MAX_BODY_BYTES: '1',
      AUTH_GITHUB_OAUTH_CALLBACK_URL: 'not a url',
    });
    const findConstraints = (path: string): string[] =>
      issues.filter((issue) => issue.path === path).map((issue) => issue.constraint);
    expect(findConstraints('DEVGUARD_LOG_LEVEL').join()).toMatch(/debug\|info/);
    expect(findConstraints('DEVGUARD_WEBHOOK_MAX_BODY_BYTES').join()).toMatch(/between/);
    // URL shape and downstream requiredness are reported independently.
    expect(findConstraints('AUTH_GITHUB_OAUTH_CALLBACK_URL').join(' | ')).toContain(
      'must be a valid absolute URL',
    );
  });

  it('treats partial GitHub App credentials as an error unit', async () => {
    const issues = loadConfigFailing({
      ...BASE_ENV,
      GITHUB_APP_PRIVATE_KEY: 'k',
      DEVGUARD_GITHUB_APP_ID: '1',
    });
    expect(issues.some((issue) => issue.path === 'DEVGUARD_GITHUB_APP_ID')).toBe(true);
  });

  it('web snapshots carry only public settings', async () => {
    const web = loadConfig('web', {
      env: { DEVGUARD_ENV: 'development', PUBLIC_API_BASE_URL: 'http://localhost:4000' },
    });
    expect(web.processKind).toBe('web');
    expect(web.publicApiBaseUrl).toBe('http://localhost:4000/');
    expect('databaseUrlRef' in web).toBe(false);
  });

  it('flags unknown variables: rejected in CI, warned otherwise', async () => {
    const scan = scanForUnknownVariables({ DEVGUARD_TOTALLY_UNKNOWN: 'x', PATH: '/bin' });
    expect(scan.unknown).toEqual(['DEVGUARD_TOTALLY_UNKNOWN']);

    let ciIssuePaths: string[] = [];
    try {
      loadConfig('api', { env: { ...BASE_ENV, CI: 'true', DEVGUARD_TOTALLY_UNKNOWN: 'x' } });
    } catch (error) {
      ciIssuePaths = ((error as DevGuardError).safeDetails as Array<{ path: string }>).map(
        (issue) => issue.path,
      );
    }
    expect(ciIssuePaths).toContain('DEVGUARD_TOTALLY_UNKNOWN');

    const devSnapshot = loadConfig('api', { env: { ...BASE_ENV, DEVGUARD_TOTALLY_UNKNOWN: 'x' } });
    expect(devSnapshot.warnings.join('\n')).toMatch(/unknown variable names/);
  });

  it('rejects misspelled FLAG_* variables even outside CI (fail closed)', () => {
    // Typo'd flag must never be silently ignored.
    let ciIssuePaths: string[] = [];
    try {
      loadConfig('api', {
        env: { ...BASE_ENV, CI: 'true', FLAG_GITHUB_WRITE_ENABLED: 'true' },
      });
    } catch (error) {
      ciIssuePaths = ((error as { safeDetails?: Array<{ path: string }> }).safeDetails ?? []).map(
        (issue) => issue.path,
      );
    }
    expect(ciIssuePaths).toContain('FLAG_GITHUB_WRITE_ENABLED');

    const dev = loadConfig('api', {
      env: { ...BASE_ENV, FLAG_GITHUB_WRITE_ENABLED: 'true' },
    });
    expect(dev.warnings.join('\n')).toMatch(/FLAG_GITHUB_WRITE_ENABLED/);
  });

  it('rejects malformed flag names that evade the namespace regex (Qodo fix)', () => {
    // These never matched isOwnedNamespace, so they must still be caught by
    // the closed FLAG_ registry check.
    const malformed = [
      'FLAG_githubWritesEnabled', // lowercase segments
      'FLAG_FEATURE_1', // digit segment
      'flag_webhook_ingress_enabled', // lowercase prefix
      'FLAG_', // empty name
      'FLAG__WEBHOOK_INGRESS_ENABLED', // double underscore
    ];
    let issuePaths: string[] = [];
    try {
      loadConfig('api', {
        env: {
          ...BASE_ENV,
          CI: 'true',
          ...Object.fromEntries(malformed.map((name) => [name, 'true'])),
        },
      });
    } catch (error) {
      issuePaths = ((error as { safeDetails?: Array<{ path: string }> }).safeDetails ?? []).map(
        (issue) => issue.path,
      );
    }
    for (const name of malformed) {
      expect(issuePaths, `${name} must be rejected as unknown`).toContain(name);
    }

    // Canonical flags remain valid.
    const canonical = loadConfig('api', {
      env: { ...BASE_ENV, CI: 'true', FLAG_WEBHOOK_INGRESS_ENABLED: 'true' },
    });
    expect(canonical.features['webhookIngressEnabled'].value).toBe(true);
  });
});

function loadConfigFailing(
  env: Record<string, string | undefined>,
): Array<{ path: string; constraint: string }> {
  try {
    loadConfig('api', { env });
    throw new Error('expected CONFIGURATION_INVALID failure');
  } catch (error) {
    if (error instanceof DevGuardError) {
      return [...(error.safeDetails as Array<{ path: string; constraint: string }>)];
    }
    if ((error as Error).message.includes('expected CONFIGURATION_INVALID')) throw error;
    return configurationInvalid([]).safeDetails as never;
  }
}

describe('C002 determinism and safe summary', () => {
  it('produces identical hashes across loads regardless of wall clock', async () => {
    const first = loadConfig('worker', { env: { ...BASE_ENV }, now: () => new Date(0) });
    const second = loadConfig('worker', { env: { ...BASE_ENV }, now: () => new Date(10_000) });
    expect(first.hash).toBe(second.hash);
    expect(first.loadedAt).not.toBe(second.loadedAt);
  });

  it('changes hash when meaningful inputs change', async () => {
    const base = loadConfig('worker', { env: { ...BASE_ENV } });
    const changed = loadConfig('worker', { env: { ...BASE_ENV, DEVGUARD_LOG_LEVEL: 'debug' } });
    expect(base.hash).not.toBe(changed.hash);
  });

  it('summarizes presence only — never values', async () => {
    const summary = safeSummary(loadConfig('api', { env: { ...BASE_ENV } }));
    expect(summary.hasDatabaseCredentials).toBe(true);
    expect(summary.features['githubWritesEnabled']).toBe(false);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('secret-value');
  });
});
