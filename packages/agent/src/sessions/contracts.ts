/**
 * C037/C038/C040 — agent session/turn lifecycle contracts.
 *
 * Provider-neutral session/turn references, strict state unions with an
 * exhaustive FSM, one-active-turn enforcement, durable command idempotency,
 * cancellation-generation fencing, and trust-labelled context input. Provider
 * types, raw chain-of-thought, and ungoverned tool profiles NEVER cross the
 * domain boundary. These extend the C036 TrueForge contract-verification
 * package (`@devguard/agent`) with the application session/turn layer.
 */
import { z } from 'zod';
import { idSchemas } from '@devguard/contracts';

export const AGENT_BATCH_SCHEMA_VERSION = 1 as const;

export const AGENT_SESSION_STATUSES = [
  'CREATING',
  'READY',
  'TURN_ACTIVE',
  'CANCELLING',
  'CANCELLED',
  'COMPLETED',
  'FAILED',
  'RECONCILING',
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];
export const AGENT_SESSION_TERMINAL: readonly AgentSessionStatus[] = [
  'CANCELLED',
  'COMPLETED',
  'FAILED',
];

export const AGENT_TURN_STATUSES = [
  'REQUESTED',
  'SUBMITTING',
  'RUNNING',
  'PAUSED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'RECONCILING',
] as const;
export type AgentTurnStatus = (typeof AGENT_TURN_STATUSES)[number];
export const AGENT_TURN_TERMINAL: readonly AgentTurnStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export const TURN_PURPOSES = [
  'WORKFLOW',
  'USER_FOLLOWUP',
  'REQUIRED_ACTION_RESULT',
  'RECOVERY',
] as const;
export type TurnPurpose = (typeof TURN_PURPOSES)[number];

export const agentSessionRefSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    provider: z.string().min(1).max(64),
    providerSessionId: z.string().min(1).max(256).optional(),
    providerThreadId: z.string().min(1).max(256).optional(),
    providerVersion: z.string().min(1).max(64),
    status: z.enum(AGENT_SESSION_STATUSES),
  })
  .strict();
export interface AgentSessionRef {
  readonly sessionId: string;
  readonly provider: string;
  readonly providerSessionId?: string | undefined;
  readonly providerThreadId?: string | undefined;
  readonly providerVersion: string;
  readonly status: AgentSessionStatus;
}

export const agentTurnRefSchema = z
  .object({
    turnId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    ordinal: z.number().int().positive(),
    providerTurnId: z.string().min(1).max(256).optional(),
    providerThreadId: z.string().min(1).max(256).optional(),
    status: z.enum(AGENT_TURN_STATUSES),
  })
  .strict();
export interface AgentTurnRef {
  readonly turnId: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly providerTurnId?: string | undefined;
  readonly providerThreadId?: string | undefined;
  readonly status: AgentTurnStatus;
}

export const agentSessionSchema = z
  .object({
    id: z.string().min(1).max(128),
    workflowRunId: idSchemas.workflowRunId,
    repositoryId: z.string().min(1).max(128),
    agentDefinitionId: z.string().min(1).max(128),
    agentVersion: z.string().min(1).max(64),
    provider: z.string().min(1).max(64),
    contractSnapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
    providerSessionId: z.string().min(1).max(256).optional(),
    providerThreadId: z.string().min(1).max(256).optional(),
    status: z.enum(AGENT_SESSION_STATUSES),
    currentTurnId: z.string().min(1).max(128).optional(),
    cancellationGeneration: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    startedAtIso: z.string().min(1).max(40),
    updatedAtIso: z.string().min(1).max(40),
    commandKey: z.string().min(1).max(128),
  })
  .strict();
export interface AgentSession {
  readonly id: string;
  readonly workflowRunId: string;
  readonly repositoryId: string;
  readonly agentDefinitionId: string;
  readonly agentVersion: string;
  readonly provider: string;
  readonly contractSnapshotDigest: string;
  readonly providerSessionId?: string | undefined;
  readonly providerThreadId?: string | undefined;
  readonly status: AgentSessionStatus;
  readonly currentTurnId?: string | undefined;
  readonly cancellationGeneration: number;
  readonly version: number;
  readonly startedAtIso: string;
  readonly updatedAtIso: string;
  readonly commandKey: string;
}

export const agentTurnSchema = z
  .object({
    id: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    ordinal: z.number().int().positive(),
    purpose: z.enum(TURN_PURPOSES),
    commandKey: z.string().min(1).max(128),
    inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
    toolProfileId: z.string().min(1).max(128),
    status: z.enum(AGENT_TURN_STATUSES),
    providerTurnId: z.string().min(1).max(256).optional(),
    providerTerminalReason: z.string().max(64).optional(),
    finalResponseDigest: z.string().max(64).optional(),
    errorCode: z.string().max(64).optional(),
    startedAtIso: z.string().min(1).max(40),
    completedAtIso: z.string().min(1).max(40).optional(),
    version: z.number().int().nonnegative().optional(),
  })
  .strict();
export interface AgentTurn {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly purpose: TurnPurpose;
  readonly commandKey: string;
  readonly inputDigest: string;
  readonly toolProfileId: string;
  readonly status: AgentTurnStatus;
  readonly providerTurnId?: string | undefined;
  readonly providerTerminalReason?: string | undefined;
  readonly finalResponseDigest?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly startedAtIso: string;
  readonly completedAtIso?: string | undefined;
  /** Optimistic-concurrency version populated by durable stores. */
  readonly version?: number | undefined;
}

export const ensureAgentSessionSchema = z
  .object({
    workflowRunId: idSchemas.workflowRunId,
    repositoryId: z.string().min(1).max(128),
    agentDefinitionId: z.string().min(1).max(128),
    agentVersion: z.string().min(1).max(64),
    contractSnapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
    commandKey: z.string().min(1).max(128),
  })
  .strict();
export interface EnsureAgentSession {
  readonly workflowRunId: string;
  readonly repositoryId: string;
  readonly agentDefinitionId: string;
  readonly agentVersion: string;
  readonly contractSnapshotDigest: string;
  readonly commandKey: string;
}

export const submitAgentTurnSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    commandId: z.string().min(1).max(128),
    purpose: z.enum(TURN_PURPOSES),
    workflowObjectiveRef: z.string().min(1).max(128),
    workflowDefinitionVersion: z.string().min(1).max(64),
    policySnapshotRef: z.string().min(1).max(128),
    trustContextSnapshotRef: z.string().min(1).max(128),
    toolProfileId: z.string().min(1).max(128),
    contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
    expectedVersion: z.number().int().nonnegative(),
    expectedCancellationGeneration: z.number().int().nonnegative(),
    linkedPausedTurnId: z.string().min(1).max(128).optional(),
  })
  .strict();
export interface SubmitAgentTurn {
  readonly sessionId: string;
  readonly commandId: string;
  readonly purpose: TurnPurpose;
  readonly workflowObjectiveRef: string;
  readonly workflowDefinitionVersion: string;
  readonly policySnapshotRef: string;
  readonly trustContextSnapshotRef: string;
  readonly toolProfileId: string;
  readonly contextDigest: string;
  readonly expectedVersion: number;
  readonly expectedCancellationGeneration: number;
  readonly linkedPausedTurnId?: string | undefined;
}

export const observeAgentTurnSchema = z.object({ turnId: z.string().min(1).max(128) }).strict();

export interface AgentTurnObservation {
  readonly turn: AgentTurn;
  readonly observation: 'completed' | 'paused' | 'running';
  readonly status: AgentTurnStatus;
  readonly summaryRef?: string | undefined;
}

export const reconcileAgentSessionSchema = z
  .object({ sessionId: z.string().min(1).max(128) })
  .strict();

// ---- C038 turn stream event contracts ----
export const TURN_EVENT_TYPES = [
  'turn.started.v1',
  'turn.delta.v1',
  'turn.paused.v1',
  'turn.completed.v1',
  'turn.failed.v1',
] as const;
export type TurnEventType = (typeof TURN_EVENT_TYPES)[number];

export const turnEventSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.enum(TURN_EVENT_TYPES),
    turnId: z.string().min(1).max(128),
    sequence: z.number().int().nonnegative(),
    providerCursor: z.string().min(1).max(128),
    providerSourceType: z.string().max(32),
    status: z.string().max(32),
    textDigest: z.string().max(64).optional(),
    occurredAtIso: z.string().min(1).max(40),
  })
  .strict();
export interface TurnEvent {
  readonly id: string;
  readonly type: TurnEventType;
  readonly turnId: string;
  readonly sequence: number;
  readonly providerCursor: string;
  readonly providerSourceType: string;
  readonly status: string;
  readonly textDigest?: string | undefined;
  readonly occurredAtIso: string;
}

// ---- C040 context / subagents / cancellation / errors ----
export const agentContextSnapshotRefSchema = z
  .object({
    ref: z.string().min(1).max(128),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    category: z.enum(['policy', 'repository_instruction', 'workflow', 'task']),
    capturedAtIso: z.string().min(1).max(40),
  })
  .strict();
export interface AgentContextSnapshotRef {
  readonly ref: string;
  readonly digest: string;
  readonly category: 'policy' | 'repository_instruction' | 'workflow' | 'task';
  readonly capturedAtIso: string;
}

export interface SubmitSubAgentTurn {
  readonly parentSessionId: string;
  readonly purpose: 'SUBAGTASK';
  readonly objective: string;
  readonly boundaryDigest: string;
  readonly toolProfileId: string;
}

export const agentContractsSchema = {
  ensureAgentSessionSchema,
  submitAgentTurnSchema,
  observeAgentTurnSchema,
  reconcileAgentSessionSchema,
  agentSessionRefSchema,
  agentTurnRefSchema,
  agentSessionSchema,
  agentTurnSchema,
  turnEventSchema,
  agentContextSnapshotRefSchema,
};
