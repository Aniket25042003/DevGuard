import { describe, expect, it } from 'vitest';
import '../errors.js';
import { McpPolicyGateway, AllowReadOnlyPolicyPort } from './mcp-policy-gateway.js';
import { ToolProfileRegistry } from './tool-profiles.js';
import { normalizeToolArguments } from './argument-normalizer.js';
import { InMemoryToolIntentStore } from './intent-store.js';
import type { ToolProfileEntry, ToolProposal } from './contracts.js';

const INIT = '2026-08-28T00:00:00.000Z';
const profiles: ToolProfileEntry[] = [
  {
    toolName: 'read_file',
    schemaVersion: '1',
    actionId: 'action:read',
    providerRisk: 'read_only',
    enabled: true,
    directMutative: false,
  },
  {
    toolName: 'create_branch',
    schemaVersion: '1',
    actionId: 'action:branch',
    providerRisk: 'mutative_external',
    enabled: true,
    directMutative: false,
  },
  {
    toolName: 'push_force',
    schemaVersion: '1',
    actionId: 'action:force',
    providerRisk: 'high',
    enabled: true,
    directMutative: true,
  },
  {
    toolName: 'exec_type',
    schemaVersion: '1',
    actionId: 'action:exec',
    providerRisk: 'high',
    enabled: false,
    directMutative: false,
  },
];

function proposal(toolName: string, callId = 'call-1'): ToolProposal {
  return {
    provider: 'trueforge',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    providerToolCallId: callId,
    toolName,
    schemaVersion: '1',
    rawArgumentsDigest: 'a'.repeat(64),
    toolProfileId: 'profile-1',
  };
}

function gateway() {
  const registry = new ToolProfileRegistry(profiles);
  const decisions = new AllowReadOnlyPolicyPort();
  const intents = new InMemoryToolIntentStore();
  const gw = new McpPolicyGateway({
    registry,
    decisions,
    intents,
    toolProfileId: 'profile-1',
    clock: { nowIso: () => INIT },
  });
  return { registry, intents, gw };
}

describe('C039 tool profile registry', () => {
  it('fails closed on unknown, disabled, and direct-mutative tools', () => {
    const { registry } = gateway();
    expect(registry.lookup('read_file', 'profile-1').ok).toBe(true);
    expect(registry.lookup('nope', 'profile-1').code).toBe('UNKNOWN_TOOL_DENIED');
    expect(registry.lookup('exec_type', 'profile-1').code).toBe('PROFILE_DISABLED');
    expect(registry.lookup('push_force', 'profile-1').code).toBe('DIRECT_MUTATIVE_DENIED');
    const pre = registry.preflight();
    expect(pre.ok).toBe(false);
  });
});

describe('C039 argument normalization', () => {
  it('accepts bounded args, rejects schema mismatch and smuggled ids', () => {
    expect(normalizeToolArguments({ path: 'a.txt' }, '1', '1').ok).toBe(true);
    expect(normalizeToolArguments({ path: 'a.txt' }, '1', '2').code).toBe('TOOL_SCHEMA_MISMATCH');
    expect(normalizeToolArguments({ sessionId: 'other-session' }, '1', '1').code).toBe(
      'CROSS_REPO_SESSION_ARGUMENT',
    );
    expect(normalizeToolArguments('not-an-object', '1', '1').code).toBe('MALFORMED_ARGUMENTS');
  });
});

describe('C039 MCP policy gateway', () => {
  it('allows read-only tools and persists the intent before effect', async () => {
    const { intents, gw } = gateway();
    const d = await gw.intercept(proposal('read_file'), { path: 'README.md' });
    expect(d.result).toBe('ALLOW');
    if (d.result !== 'ALLOW') return;
    expect((await intents.get(d.intent.id))?.status).toBe('ALLOWED');
  });

  it('requires approval for external mutative actions and gates execution', async () => {
    const { intents, gw } = gateway();
    const d = await gw.intercept(proposal('create_branch'), { name: 'agent/x' });
    expect(d.result).toBe('APPROVAL_REQUIRED');
    if (d.result !== 'APPROVAL_REQUIRED') return;
    await expect(gw.authorizeExecution(d.intent.id, 'wrong-action')).rejects.toThrow();
    const grant = await gw.authorizeExecution(d.intent.id, d.intent.actionId);
    expect(grant.toolName).toBe('create_branch');
    expect((await intents.get(d.intent.id))?.status).toBe('AUTHORIZED_EXECUTION');
  });

  it('replays the same provider tool-call id idempotently', async () => {
    const { intents, gw } = gateway();
    const one = await gw.intercept(proposal('read_file', 'call-idem'), { path: 'x' });
    const two = await gw.intercept(proposal('read_file', 'call-idem'), { path: 'x' });
    expect(one.result).toBe('ALLOW');
    if (one.result === 'ALLOW' && two.result === 'ALLOW') expect(two.intent.id).toBe(one.intent.id);
    expect((await intents.get(one.result === 'ALLOW' ? one.intent.id : 'x'))?.id).toBeDefined();
  });

  it('denies unknown tools with a typed disposition (no intent leak)', async () => {
    const { gw } = gateway();
    const d = await gw.intercept(proposal('watch_live_memory'), {});
    expect(d.result).toBe('DENY');
    if (d.result === 'DENY') expect(d.code).toBe('UNKNOWN_TOOL_DENIED');
  });
});
