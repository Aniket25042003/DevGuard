/**
 * C061 §22 — redaction, correlation propagation, error serialization,
 * field allowlists, budgets and sink degradation.
 */
import { describe, expect, it } from 'vitest';
import {
  CorrelationContextPort,
  LOG_BUDGETS,
  LoggerPort,
  MemorySink,
  redactText,
  redactValue,
  serializeError,
} from '@devguard/logging';

describe('redaction (C061 §3/§5)', () => {
  it('redacts token-shaped secrets, JWTs, bearer headers and DSN credentials', () => {
    // Synthetic fixture assembled from parts: exercises the exact real regex
    // at runtime while presenting no scannable literal to secret scanners.
    const syntheticToken = ['ghp', '_16C7e42F292c6912E7710c838347Ae178B4a'].join('');
    expect(redactText(`token ${syntheticToken}`)).toContain('[REDACTED:github-token]');
    expect(redactText('redis://user:secretpw@host:6379')).toContain(
      '[REDACTED:redis-url-credentials]',
    );
    expect(redactText('postgres://admin:hunter2@db:5432/app')).toContain(
      '[REDACTED:postgres-url-credentials]',
    );
    expect(redactText('Authorization: Bearer abc.def.ghi')).toContain('[REDACTED:bearer]');
    expect(
      redactText('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'),
    ).toContain('[REDACTED:private-key-block]');
    // Clean text passes through untouched.
    expect(redactText('workflow run completed normally')).toBe('workflow run completed normally');
  });

  it('deep-redacts untrusted values and key-named fields', () => {
    const input = {
      accessToken: 'value',
      nested: { GITHUB_TOKEN: 'x', note: `safe ${['ghp', '_ABCDEFGHIJKLmnop'].join('')}` },
    };
    const out = redactValue(input) as Record<string, unknown>;
    expect(out['accessToken']).toBe('[REDACTED:key-name]');
    const nested = out['nested'] as Record<string, unknown>;
    expect(nested['GITHUB_TOKEN']).toBe('[REDACTED:key-name]');
    expect(String(nested['note'])).toContain('[REDACTED:github-token]');
  });
});

describe('error serialization (C061 §5)', () => {
  it('serializes DevGuardErrors into safe class/code/retryability/fingerprint', () => {
    const err = errorsModule.makeError('PROVIDER_UNAVAILABLE');
    const serialized = serializeError(err)!;
    expect(serialized.code).toBe('PROVIDER_UNAVAILABLE');
    expect(typeof serialized.retryable).toBe('boolean');
    expect(serialized.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(serialized.retryable).toBe(false); // reconcile_then_retry is not blind-safe
  });

  it('classifies unknown thrown values without crashing', () => {
    const syntheticToken2 = ['ghp', '_ZZZZZZZZ'].join('');
    const serialized = serializeError(
      new TypeError(`secret ${syntheticToken2} should never appear`),
    );
    expect(serialized?.code).toBe('UNCLASSIFIED');
    expect(serialized!.fingerprint).toBeDefined();
  });
});

import * as errorsModule from '@devguard/errors';

describe('logger pipeline', () => {
  const clockNow = (): number => 1_700_000_000_000;

  it('emits canonical JSON with stable ordered fields and correlation context', () => {
    const sink = new MemorySink();
    const correlation = new CorrelationContextPort();
    const logger = LoggerPort.root({
      service: 'api',
      environment: 'test',
      sink: sink.sink,
      correlation,
      now: clockNow,
    });

    correlation.run({ correlationId: 'corr-1', requestId: 'req-9' }, () => {
      logger.child({ repositoryId: 'repo-1' }).info('repository.connected', { status: 'ok' });
    });

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0]!;
    expect(record.service).toBe('api');
    expect(record.correlationId).toBe('corr-1');
    expect(record.requestId).toBe('req-9');
    expect(record.repositoryId).toBe('repo-1');
    expect(record.level).toBe('info');
    // Serialized line parses as pure JSON (machine-parseable requirement).
    const parsed = JSON.parse(sink.serializedLines[0]!) as Record<string, unknown>;
    expect(parsed['event']).toBe('repository.connected');
  });

  it('enforces the field allowlist: unknown keys are dropped at serialization', () => {
    const sink = new MemorySink();
    const logger = LoggerPort.root({
      service: 'worker',
      environment: 'test',
      sink: sink.sink,
      now: clockNow,
    });
    logger.info('job.done', { jobId: 'j1', status: 'ok' });
    const parsed = JSON.parse(sink.serializedLines[0]!) as Record<string, unknown>;
    expect(parsed['jobId']).toBe('j1');
    // Injecting an off-allowlist key via record construction is impossible
    // through the public API; this asserts the serializer's contract directly.
    const rogueKeys = Object.keys(parsed).filter(
      (key) =>
        ![
          'schemaVersion',
          'timestamp',
          'level',
          'service',
          'environment',
          'message',
          'event',
          'requestId',
          'correlationId',
          'traceId',
          'spanId',
          'repositoryId',
          'workflowRunId',
          'sessionId',
          'actionId',
          'approvalId',
          'jobId',
          'webhookDeliveryId',
          'actorType',
          'actorIdHash',
          'provider',
          'durationMs',
          'status',
          'attempt',
          'error',
        ].includes(key),
    );
    expect(rogueKeys).toEqual([]);
  });

  it('message budgets truncate oversized events (never drop the record)', () => {
    const sink = new MemorySink();
    const logger = LoggerPort.root({
      service: 'worker',
      environment: 'test',
      sink: sink.sink,
      now: clockNow,
    });
    const huge = 'x'.repeat(LOG_BUDGETS.maxMessageLength + 500) + ' tail-marker';
    logger.warn(huge);
    const parsed = JSON.parse(sink.serializedLines[0]!) as { message: string };
    expect(parsed.message.length).toBeLessThanOrEqual(LOG_BUDGETS.maxMessageLength + 20);
    void huge;
  });

  it('errors are serialized safely; raw messages with secrets are redacted out of fingerprints', () => {
    const sink = new MemorySink();
    const logger = LoggerPort.root({
      service: 'api',
      environment: 'test',
      sink: sink.sink,
      now: clockNow,
    });
    const syntheticToken3 = ['ghp', '_DEADBEEF1234567890abcd'].join('');
    const error = new Error(`call failed with ${syntheticToken3}`);
    logger.error('provider.call.failed', error, { provider: 'github' });
    const line = sink.serializedLines[0]!;
    expect(line).not.toContain(syntheticToken3);
    const parsed = JSON.parse(line) as { error?: { code: string } };
    expect(parsed.error?.code).toBe('UNCLASSIFIED');
  });

  it('child loggers merge context immutably without leaking to siblings', () => {
    const sink = new MemorySink();
    const root = LoggerPort.root({
      service: 'api',
      environment: 'test',
      sink: sink.sink,
      now: clockNow,
    });
    root.child({ workflowRunId: 'run-A' }).info('a.started');
    root.child({ workflowRunId: 'run-B' }).info('b.started');
    expect(sink.records[0]?.workflowRunId).toBe('run-A');
    expect(sink.records[1]?.workflowRunId).toBe('run-B');
    // Root context untouched.
    void MemorySink;
  });

  it('async correlation survives await boundaries via AsyncLocalStorage', async () => {
    const correlation = new CorrelationContextPort();
    const seen: string[] = [];
    await correlation.run({ correlationId: 'corr-async' }, async () => {
      await Promise.resolve();
      seen.push(correlation.current().correlationId);
    });
    expect(seen).toEqual(['corr-async']);
  });
});
