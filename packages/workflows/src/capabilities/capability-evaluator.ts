/**
 * C045 §15/§23.5 — capability requirement evaluation.
 *
 * Definitions declare REQUIRED provider capabilities; C036 verifies them
 * against the pinned provider and produces a manifest. C045 evaluates
 * requirements against that manifest and FAILS CLOSED: a required capability
 * that is absent, unverified, or version-incompatible blocks the workflow
 * (catalog shows blocked; no provider call is ever made for it).
 */
import { makeError } from '@devguard/errors';
import { compareSemver } from '../schemas/semver.js';
import type { Semver } from '../schemas/semver.js';
import type { CapabilityRef } from '../schemas/workflow-definition.js';
import { isKnownCapability } from '../definitions/catalogs.js';
import { versionOf } from '../definitions/definition-validator.js';

export interface VerifiedCapability {
  readonly id: string;
  readonly verified: true;
  /** Provider-reported capability version (C036), optional for wide capability ids. */
  readonly version?: Semver | undefined;
  readonly verifiedAt: string;
}

export interface CapabilityManifest {
  readonly capabilities: readonly VerifiedCapability[];
}

export interface CapabilityEvaluation {
  readonly satisfied: boolean;
  readonly reasons: readonly string[];
}

function verifiedById(manifest: CapabilityManifest): ReadonlyMap<string, VerifiedCapability> {
  const map = new Map<string, VerifiedCapability>();
  for (const entry of manifest.capabilities) {
    // Fail closed: manifest entries with unknown capability ids can never
    // satisfy a requirement (they are ignored, not trusted).
    if (isKnownCapability(entry.id)) {
      map.set(entry.id, entry);
    }
  }
  return map;
}

/** Cases a requirement's optional version pins hold for the manifest entry. */
function versionAccepts(required: Semver | undefined, actual: Semver | undefined): boolean {
  if (required === undefined) return true;
  if (actual === undefined) {
    // No provider-reported version: cannot verify the minimum — fail closed.
    return false;
  }
  return compareSemver(actual, required) >= 0;
}

/**
 * Fail-closed evaluation: every required capability must be known, present,
 * verified and version-compatible. Unknown capability ids in the REQUIREMENT
 * are caught at definition validation (`WORKFLOW_CROSS_REFERENCE_UNKNOWN`).
 */
export function evaluateCapabilityRequirements(
  requirements: readonly CapabilityRef[],
  manifest: CapabilityManifest,
): CapabilityEvaluation {
  const verified = verifiedById(manifest);
  const reasons: string[] = [];
  for (const requirement of requirements) {
    const entry = verified.get(requirement.id);
    if (entry === undefined) {
      reasons.push(`capability '${requirement.id}' is not verified by the provider manifest`);
      continue;
    }
    if (requirement.version !== undefined && !versionAccepts(requirement.version, entry.version)) {
      reasons.push(
        `capability '${requirement.id}' version ${entry.version !== undefined ? versionOf(entry.version) : '(unknown)'} does not satisfy the required minimum ${versionOf(requirement.version)}`,
      );
    }
  }
  return Object.freeze({
    satisfied: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}

/** Throwing variant used by launch validation (C045 §11). */
export function assertCapabilitiesSupported(
  requirements: readonly CapabilityRef[],
  manifest: CapabilityManifest | undefined,
): void {
  if (manifest === undefined && requirements.length > 0) {
    const first = requirements[0];
    throw makeError('WORKFLOW_CAPABILITY_UNSUPPORTED', {
      details: {
        capabilityId: first?.id ?? 'unknown',
        reason: 'capability manifest unavailable — fail closed',
      },
    });
  }
  if (manifest === undefined) return;
  const evaluation = evaluateCapabilityRequirements(requirements, manifest);
  if (!evaluation.satisfied) {
    const first = requirements[0];
    throw makeError('WORKFLOW_CAPABILITY_UNSUPPORTED', {
      details: {
        capabilityId: first?.id ?? 'unknown',
        reason: evaluation.reasons[0],
      },
    });
  }
}
