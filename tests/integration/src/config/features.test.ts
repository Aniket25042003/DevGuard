import { describe, expect, it } from 'vitest';
import {
  createFeatureGate,
  EnvironmentSecretProvider,
  evaluateFeatures,
  loadConfig,
  secretRef,
  toPublicConfig,
} from '@devguard/config';
import type { FeatureKey } from '@devguard/config';
import { DevGuardError } from '@devguard/errors';

// AUTH_MODE=none is valid outside production and keeps fixtures minimal.
const BASE_ENV = {
  DEVGUARD_ENV: 'test',
  DATABASE_URL: 'x',
  REDIS_URL: 'y',
  AUTH_MODE: 'none',
} as const;

describe('C002 secret reference separation', () => {
  it('keeps values out of snapshots by construction', () => {
    const snapshot = loadConfig('api', { env: { ...BASE_ENV } });
    expect(snapshot.databaseUrlRef).toEqual({ name: 'x' });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('"name":"x"');
    expect(serialized).not.toContain('resolved-value');
  });

  it('resolves refs only through the provider port and fails closed when missing', async () => {
    const provider = new EnvironmentSecretProvider({ MY_SECRET: 'resolved-value' });
    await expect(provider.get(secretRef('MY_SECRET'))).resolves.toBe('resolved-value');
    await expect(provider.get(secretRef('MISSING_SECRET'))).rejects.toMatchObject({
      code: 'CONFIGURATION_INVALID',
    });
    // Versioned refs stay rotation-safe.
    await expect(provider.get(secretRef('MISSING_SECRET', 'v2'))).rejects.toThrowError();
  });
});

describe('C002 feature flags', () => {
  it('defaults every capability off (conservative production defaults)', () => {
    const { decisions } = evaluateFeatures({});
    for (const key of Object.keys(decisions) as FeatureKey[]) {
      expect(decisions[key]).toEqual({ key, value: false, source: 'default' });
    }
  });

  it('applies precedence code default < environment override with strict booleans', () => {
    const enabled = evaluateFeatures({ FLAG_WEBHOOK_INGRESS_ENABLED: 'true' });
    expect(enabled.decisions['webhookIngressEnabled']).toEqual({
      key: 'webhookIngressEnabled',
      value: true,
      source: 'environment',
    });

    const invalid = evaluateFeatures({ FLAG_WEBHOOK_INGRESS_ENABLED: 'yes' });
    expect(invalid.issues.some((issue) => issue.path === 'FLAG_WEBHOOK_INGRESS_ENABLED')).toBe(
      true,
    );
  });

  it('narrow-safety: sandbox execution requires the TrueForge runtime flag', () => {
    const { decisions, issues } = evaluateFeatures({
      FLAG_SANDBOX_EXECUTION_ENABLED: 'true',
    });
    expect(
      issues.some((issue) => issue.constraint.includes('FLAG_TRUEFORGE_INTEGRATION_ENABLED')),
    ).toBe(true);
    expect(decisions['sandboxExecutionEnabled'].value).toBe(false);

    const valid = evaluateFeatures({
      FLAG_SANDBOX_EXECUTION_ENABLED: 'true',
      FLAG_TRUEFORGE_INTEGRATION_ENABLED: 'true',
    });
    expect(valid.issues).toHaveLength(0);
    expect(valid.decisions['sandboxExecutionEnabled'].value).toBe(true);
  });

  it('rejects devNoAuthMode in production via load validation', () => {
    try {
      loadConfig('api', {
        env: { ...BASE_ENV, DEVGUARD_ENV: 'production', FLAG_DEV_NO_AUTH_MODE: 'true' },
      });
      throw new Error('expected failure');
    } catch (error) {
      if (error instanceof DevGuardError) {
        const paths = (error.safeDetails as Array<{ path: string }>).map((issue) => issue.path);
        expect(paths).toContain('FLAG_DEV_NO_AUTH_MODE');
      } else {
        throw error;
      }
    }
  });

  it('exposes typed gate evaluation and fails closed on unknown keys', async () => {
    const { decisions } = evaluateFeatures({ FLAG_TRUEFORGE_INTEGRATION_ENABLED: 'true' });
    const gate = createFeatureGate(decisions);
    expect(gate.evaluate('trueforgeIntegrationEnabled').value).toBe(true);
    expect(() => gate.evaluate('madeUpFlag' as FeatureKey)).toThrowError(/Unknown feature key/);
  });

  it('emits feature_flag.changed events only for environment overrides', async () => {
    const events: string[] = [];
    loadConfig('api', {
      env: { ...BASE_ENV, FLAG_WEBHOOK_INGRESS_ENABLED: 'true' },
      onEvent: (event) => events.push(event.type),
    });
    expect(events.filter((type) => type === 'feature_flag.changed')).toHaveLength(1);
    expect(events).toContain('configuration.validated');
  });
});

describe('C002 public projection allow-list', () => {
  it('projects only public fields from a web snapshot', () => {
    const web = loadConfig('web', {
      env: { DEVGUARD_ENV: 'test', PUBLIC_API_BASE_URL: 'http://api.local' },
    });
    const pub = toPublicConfig(web);
    expect(Object.keys(pub).sort()).toEqual(['apiBaseUrl', 'authDisplayMode', 'environment']);
    expect(pub.apiBaseUrl).toBe('http://api.local/');
  });

  it('refuses server snapshots', () => {
    const api = loadConfig('api', { env: { ...BASE_ENV } });
    expect(() => toPublicConfig(api)).toThrowError(/web process/);
  });
});

describe('C005/C002 none-mode composition honors overrides (Qodo fix)', () => {
  it('buildContainer applies injected bindings before constructing services', async () => {
    const { buildContainer } = await import('@devguard/api');
    const { loadConfig } = await import('@devguard/config');
    const config = loadConfig('api', {
      env: {
        DEVGUARD_ENV: 'test',
        DATABASE_URL: 'x',
        REDIS_URL: 'y',
        AUTH_MODE: 'none',
      },
    });
    const fakeIdentityProvider = {
      buildAuthorizeUrl: (): string => 'https://fake.example/authorize',
      exchangeCode: async (): Promise<{ accessToken: string }> => ({ accessToken: 't' }),
      fetchIdentity: async () => ({ issuer: 'https://fake', providerSubject: '9', login: 'fake' }),
    };
    const container = buildContainer(
      config,
      { DEVGUARD_ENV: 'test' },
      { identityProvider: fakeIdentityProvider },
    );
    // The injected adapter must be BOTH visible in bindings AND wired into the service.
    expect(container.bindings.identityProvider).toBe(fakeIdentityProvider);
    const started = await container.auth.startLogin({});
    expect(started.authorizeUrl).toContain('https://fake.example');
  });
});
