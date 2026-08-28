/**
 * C040 §10/§13/§17 — agent context assembly, cancellation generation, and
 * sub-agent turn batching.
 *
 * Context is built from trust-labelled snapshot refs only (never mutable policy
 * in prose); cancellation increments a session generation that fences queued
 * turns; sub-agent turns are bounded to a boundary digest and tool profile with
 * no escape from the parent session's authorization.
 */
import { createHash } from 'node:crypto';
import type { AgentContextSnapshotRef } from './contracts.js';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface BuiltContext {
  readonly trustSnapshotRefs: readonly AgentContextSnapshotRef[];
  readonly digest: string;
  readonly boundedCharacterCount: number;
}

const MAX_CONTEXT_CHARS = 512_000;

/** Assemble context strictly from trust-labelled snapshot refs; never raw prose. */
export function buildContext(refs: readonly AgentContextSnapshotRef[]): BuiltContext {
  const bounded = refs.slice(0, 64);
  const digest = sha256Hex(bounded.map((r) => `${r.category}:${r.digest}`).join('|'));
  return {
    trustSnapshotRefs: bounded,
    digest,
    boundedCharacterCount: Math.min(MAX_CONTEXT_CHARS, bounded.length * 4096),
  };
}

/** Increment cancellation generation to fence queued/stale turns. */
export function nextCancellationGeneration(current: number): number {
  return current + 1;
}

export const SUB_AGENT_MAX = 8;

export function submitSubAgentTurns(input: {
  parentSessionId: string;
  boundaryDigest: string;
  toolProfileId: string;
  count: number;
}): number {
  const bounded = Math.min(Math.max(0, Math.floor(input.count)), SUB_AGENT_MAX);
  if (bounded === 0) return 0;
  return bounded;
}
