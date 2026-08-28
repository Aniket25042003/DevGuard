import { describe, expect, it } from 'vitest';
import {
  AGENT_CAPABILITIES,
  ALL_AGENT_CAPABILITIES,
  MANDATORY_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
  evaluateCapabilities,
  isKnownCapability,
  FATAL_PROVIDER_PROPERTIES,
} from './capabilities.js';

function allVerified(): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const name of AGENT_CAPABILITIES) map.set(name, true);
  return map;
}

describe('C036 capability matrix', () => {
  it('partitions every capability into mandatory or optional exactly once', () => {
    const mandatory = new Set(MANDATORY_CAPABILITIES);
    const optional = new Set(OPTIONAL_CAPABILITIES);
    for (const name of AGENT_CAPABILITIES) {
      expect(mandatory.has(name) || optional.has(name)).toBe(true);
      expect(mandatory.has(name) && optional.has(name)).toBe(false);
    }
    expect(ALL_AGENT_CAPABILITIES).toHaveLength(AGENT_CAPABILITIES.length);
  });

  it('returns COMPATIBLE when every capability is verified and no fatal property is present', () => {
    const evaluation = evaluateCapabilities(allVerified());
    expect(evaluation.verdict).toBe('COMPATIBLE');
    expect(evaluation.missingMandatory).toEqual([]);
    expect(evaluation.missingOptional).toEqual([]);
    expect(evaluation.fatalPresent).toEqual([]);
  });

  it('fails closed to INCOMPATIBLE when a mandatory capability is missing', () => {
    const claims = allVerified();
    claims.set('mcp_interception', false);
    const evaluation = evaluateCapabilities(claims);
    expect(evaluation.verdict).toBe('INCOMPATIBLE');
    expect(evaluation.missingMandatory).toContain('mcp_interception');
  });

  it('degrades (DEGRADED) when only optional capabilities are missing', () => {
    const claims = allVerified();
    claims.set('subagents', false);
    claims.set('context_compaction', false);
    const evaluation = evaluateCapabilities(claims);
    expect(evaluation.verdict).toBe('DEGRADED');
    expect(evaluation.missingMandatory).toEqual([]);
    expect(evaluation.missingOptional.sort()).toEqual(['context_compaction', 'subagents']);
  });

  it('is INCOMPATIBLE when a FATAL property is present even if all capabilities are verified', () => {
    const evaluation = evaluateCapabilities(allVerified(), ['direct_mutative_github_tools']);
    expect(evaluation.verdict).toBe('INCOMPATIBLE');
    expect(evaluation.fatalPresent).toContain('direct_mutative_github_tools');
  });

  it('ignores fatal property names that are not in the known set (never invents)', () => {
    const evaluation = evaluateCapabilities(allVerified(), ['something_unknown']);
    expect(evaluation.verdict).toBe('COMPATIBLE');
  });

  it('fails closed on an unknown claim name', () => {
    const claims = allVerified();
    claims.set('not_a_real_capability', true);
    const evaluation = evaluateCapabilities(claims);
    expect(evaluation.verdict).toBe('INCOMPATIBLE');
    expect(evaluation.unknownClaims).toContain('not_a_real_capability');
  });

  it('recognizes only known capability names', () => {
    expect(isKnownCapability('mcp_interception')).toBe(true);
    expect(isKnownCapability('pwn_everything')).toBe(false);
    expect(FATAL_PROVIDER_PROPERTIES).toContain('direct_mutative_github_tools');
  });
});
