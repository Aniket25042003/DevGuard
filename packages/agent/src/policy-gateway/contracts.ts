/**
 * C039 — MCP policy interception and checkpoint bridge contracts.
 *
 * Every TrueForge/MCP tool proposal traverses the non-bypassable DevGuard
 * policy gateway; the exact tool -> action/risk/provider mapping is persisted
 * as a `ToolCallIntent` BEFORE any tool effect. Unknown or new tools, direct
 * mutative tools, and schema mismatches fail closed. Approval-required actions
 * pause and are bridged to a correlating TrueForge checkpoint via
 * `CheckpointLink` (which carries NO independent approval value — DevGuard is
 * the approval source of truth).
 */
import { z } from 'zod';

export const POLICY_GATEWAY_SCHEMA_VERSION = 1 as const;

export const TOOL_POLICY_RESULTS = ['ALLOW', 'DENY', 'APPROVAL_REQUIRED'] as const;
export type ToolPolicyResult = (typeof TOOL_POLICY_RESULTS)[number];

export const TOOL_INTENT_STATUSES = [
  'PROPOSED',
  'EVALUATING',
  'ALLOWED',
  'DENIED',
  'WAITING_APPROVAL',
  'AUTHORIZED_EXECUTION',
  'EXECUTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'STALE',
] as const;
export type ToolIntentStatus = (typeof TOOL_INTENT_STATUSES)[number];

export const toolProposalSchema = z
  .object({
    provider: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128),
    providerToolCallId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    schemaVersion: z.string().min(1).max(32),
    rawArgumentsDigest: z.string().regex(/^[0-9a-f]{64}$/),
    toolProfileId: z.string().min(1).max(128),
  })
  .strict();
export interface ToolProposal {
  readonly provider: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerToolCallId: string;
  readonly toolName: string;
  readonly schemaVersion: string;
  readonly rawArgumentsDigest: string;
  readonly toolProfileId: string;
}

export const toolCallIntentSchema = z
  .object({
    id: z.string().min(1).max(128),
    provider: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128),
    providerToolCallId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
    profileId: z.string().min(1).max(128),
    actionId: z.string().min(1).max(128),
    providerRisk: z.enum(['read_only', 'low', 'medium', 'high', 'mutative_external']),
    policyDecision: ToolPolicyResultSchema(),
    status: z.enum(TOOL_INTENT_STATUSES),
    normalizedArgumentsDigest: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: z.string().min(1).max(128),
    cancellationGeneration: z.number().int().nonnegative(),
    createdAtIso: z.string().min(1).max(40),
    updatedAtIso: z.string().min(1).max(40),
  })
  .strict();
export interface ToolCallIntent {
  readonly id: string;
  readonly provider: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerToolCallId: string;
  readonly toolName: string;
  readonly profileId: string;
  readonly actionId: string;
  readonly providerRisk: 'read_only' | 'low' | 'medium' | 'high' | 'mutative_external';
  readonly policyDecision: ToolPolicyResult;
  readonly status: ToolIntentStatus;
  readonly normalizedArgumentsDigest: string;
  readonly idempotencyKey: string;
  readonly cancellationGeneration: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

function ToolPolicyResultSchema(): z.ZodType<ToolPolicyResult> {
  return z.enum(TOOL_POLICY_RESULTS);
}

export const checkpointLinkSchema = z
  .object({
    id: z.string().min(1).max(128),
    toolIntentId: z.string().min(1).max(128),
    actionId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    turnId: z.string().min(1).max(128),
    providerCheckpointRef: z.string().min(1).max(128),
    syncStatus: z.enum(['PENDING', 'PAUSED', 'RESOLVED', 'FAILED']),
    createdAtIso: z.string().min(1).max(40),
  })
  .strict();
export interface CheckpointLink {
  readonly id: string;
  readonly toolIntentId: string;
  readonly actionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerCheckpointRef: string;
  readonly syncStatus: 'PENDING' | 'PAUSED' | 'RESOLVED' | 'FAILED';
  readonly createdAtIso: string;
}

export interface ToolProfileEntry {
  readonly profileId: string;
  readonly toolName: string;
  readonly schemaVersion: string;
  readonly actionId: string;
  readonly providerRisk: ToolCallIntent['providerRisk'];
  readonly enabled: boolean;
  readonly directMutative: boolean;
}

export interface AuthorizedToolExecutionGrant {
  readonly toolIntentId: string;
  readonly actionId: string;
  readonly profileId: string;
  readonly toolName: string;
  readonly cancellationGeneration: number;
}

export const policyGatewayContractsSchema = {
  toolProposalSchema,
  toolCallIntentSchema,
  checkpointLinkSchema,
};
