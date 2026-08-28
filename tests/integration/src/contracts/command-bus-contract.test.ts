/**
 * CP006 — cross-package contract: the command bus's MVP set must agree with the
 * frozen `api-contracts` MVP command list, so the transport vocabulary and the
 * challenge-gating instantiate one canonical catalogue.
 */
import { describe, expect, it } from 'vitest';
import { MVP_COMMAND_IDS_V1 } from '@devguard/api-contracts';
import { COMMAND_BUS_MVP_IDS } from '@devguard/workflows';

describe('CP006 command-bus ↔ api-contracts MVP contract', () => {
  it('the bus advertises exactly the frozen MVP commands', () => {
    const busIds = [...COMMAND_BUS_MVP_IDS].sort();
    const contractIds = [...MVP_COMMAND_IDS_V1].sort();
    expect(busIds).toEqual(contractIds);
    expect(busIds).toHaveLength(5);
  });

  it('extensions stay out of the MVP surface', () => {
    for (const extension of ['dependency_upgrade', 'repository_health_check', 'manual_refactor']) {
      expect(COMMAND_BUS_MVP_IDS.has(extension as never)).toBe(false);
      expect(MVP_COMMAND_IDS_V1).not.toContain(extension);
    }
  });
});
