/**
 * C036 §10 — the provider-neutral `AgentRuntime` boundary.
 *
 * Methods here are DevGuard contracts; unsupported operations throw
 * `RUNTIME_CAPABILITY_UNAVAILABLE` and the affected feature stays disabled /
 * fails closed. NO provider SDK type ever crosses this boundary — the provider
 * adapter (composition root) implements these interfaces and validates raw
 * payloads against pinned schemas before normalization. All fields are bounded;
 * all objects are `.strict()`.
 */
import { z } from 'zod';
import { boundedText, correlation, idSchemas, type CorrelationShape } from '@devguard/contracts';
import { agentIdSchemas, type ProviderRef } from './ids.js';

export const KNOWN_PROVIDERS = ['trueforge'] as const;
export type AgentProviderLabel = (typeof KNOWN_PROVIDERS)[number];

export function isKnownProvider(value: string): boolean {
  return (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

/** Canonical correlation header name used across provider HTTP boundaries. */
export const CORRELATION_HEADER_KEY = 'x-devguard-correlation' as const;

// --- Refs -------------------------------------------------------------------
const providerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/, 'expected an opaque provider handle');

export interface AgentSessionRefShape {
  readonly provider: AgentProviderLabel;
  readonly sessionId: ReturnType<typeof idSchemas.agentSessionRefId.parse>;
  readonly providerSessionId: ProviderRef;
  readonly version: number;
}
export interface AgentTurnRefShape {
  readonly provider: AgentProviderLabel;
  readonly sessionId: ReturnType<typeof idSchemas.agentSessionRefId.parse>;
  readonly turnId: ReturnType<typeof idSchemas.turnRefId.parse>;
  readonly providerTurnId: ProviderRef;
  readonly version: number;
}

export const agentSessionRefSchema = z
  .object({
    provider: z.enum(KNOWN_PROVIDERS),
    sessionId: idSchemas.agentSessionRefId,
    providerSessionId: agentIdSchemas.providerRef,
    version: z.number().int().nonnegative(),
  })
  .strict();
export const agentTurnRefSchema = z
  .object({
    provider: z.enum(KNOWN_PROVIDERS),
    sessionId: idSchemas.agentSessionRefId,
    turnId: idSchemas.turnRefId,
    providerTurnId: agentIdSchemas.providerRef,
    version: z.number().int().nonnegative(),
  })
  .strict();

// --- Inputs -----------------------------------------------------------------
export const createAgentSessionInputSchema = z
  .object({
    operationKey: idSchemas.operationKey,
    agentDefinitionRef: z.string().min(1).max(128).optional(),
    deadlineMs: z.number().int().positive(),
    correlation: correlationSchema().optional(),
  })
  .strict();

export interface CreateAgentSessionInput {
  readonly operationKey: ReturnType<typeof idSchemas.operationKey.parse>;
  readonly deadlineMs: number;
  readonly agentDefinitionRef?: string | undefined;
  readonly correlation?: CorrelationShape | undefined;
}

export const createAgentTurnInputSchema = z
  .object({
    operationKey: idSchemas.operationKey,
    sessionRef: agentSessionRefSchema,
    deadlineMs: z.number().int().positive(),
    resumeAfterProviderTurnId: agentIdSchemas.providerRef.optional(),
    correlation: correlationSchema().optional(),
  })
  .strict();

export interface CreateAgentTurnInput {
  readonly operationKey: ReturnType<typeof idSchemas.operationKey.parse>;
  readonly sessionRef: AgentSessionRefShape;
  readonly deadlineMs: number;
  readonly resumeAfterProviderTurnId?: ProviderRef | undefined;
  readonly correlation?: CorrelationShape | undefined;
}

export const streamAgentEventsInputSchema = z
  .object({
    operationKey: idSchemas.operationKey,
    turnRef: agentTurnRefSchema,
    cursor: z.string().min(1).max(512).optional(),
    timeoutMs: z.number().int().positive().max(86_400_000).optional(),
    heartbeatMs: z.number().int().positive().max(86_400_000).optional(),
  })
  .strict();

export interface StreamAgentEventsInput {
  readonly operationKey: ReturnType<typeof idSchemas.operationKey.parse>;
  readonly turnRef: AgentTurnRefShape;
  readonly cursor?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly heartbeatMs?: number | undefined;
}

export const requiredActionResultSchema = z
  .object({
    turnRef: agentTurnRefSchema,
    requiredActionId: agentIdSchemas.requiredActionId,
    outcome: z.enum(['approved', 'denied']),
    operationKey: idSchemas.operationKey,
    decisionId: z.string().min(1).max(128),
    approvalId: idSchemas.approvalId.optional(),
    outcomeEvidence: boundedText(400).optional(),
  })
  .strict();

export interface RequiredActionResultInput {
  readonly turnRef: AgentTurnRefShape;
  readonly requiredActionId: ReturnType<typeof agentIdSchemas.requiredActionId.parse>;
  readonly outcome: 'approved' | 'denied';
  readonly operationKey: ReturnType<typeof idSchemas.operationKey.parse>;
  readonly decisionId: string;
  readonly approvalId?: string | undefined;
  readonly outcomeEvidence?: string | undefined;
}

export const cancelRuntimeWorkSchema = z
  .object({
    turnRef: agentTurnRefSchema,
    cancellationLevel: z.enum(['graceful', 'hard']),
    operationKey: idSchemas.operationKey,
  })
  .strict();

export interface CancelRuntimeWorkInput {
  readonly turnRef: AgentTurnRefShape;
  readonly cancellationLevel: 'graceful' | 'hard';
  readonly operationKey: ReturnType<typeof idSchemas.operationKey.parse>;
}

// --- Observations -----------------------------------------------------------
export const runtimeEventKindSchema = z.enum([
  'delta',
  'required_action',
  'final',
  'error',
  'heartbeat',
  'unknown',
]);
export type RuntimeEventKind = z.infer<typeof runtimeEventKindSchema>;

export const sessionObservationStatusSchema = z.enum(['active', 'closed', 'unknown']);
export const turnObservationStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);

export interface AgentSessionObservation {
  readonly ref: AgentSessionRefShape;
  readonly status: z.infer<typeof sessionObservationStatusSchema>;
  readonly createdAt: string;
  readonly activeTurnRef?: AgentTurnRefShape | undefined;
  readonly providerServerId?: string | undefined;
  readonly providerVersion: string;
  readonly oneActiveTurnConfirmed: boolean;
}

export interface AgentTurnObservation {
  readonly ref: AgentTurnRefShape;
  readonly status: z.infer<typeof turnObservationStatusSchema>;
  readonly oneActiveTurnConfirmed: boolean;
  readonly finalResponseAvailable: boolean;
  readonly providerVersion: string;
  readonly errorSummaryRedacted?: string | undefined;
}

/**
 * A normalized runtime event. `payload` is a validated, redacted provider
 * payload projected to neutral shapes — never a raw provider dump and never
 * prompt/token/chain-of-thought content.
 */
export interface RuntimeEventEnvelope {
  readonly eventId: ReturnType<typeof idSchemas.eventId.parse>;
  readonly providerEventId?: string | undefined;
  readonly sessionRef: AgentSessionRefShape;
  readonly turnRef: AgentTurnRefShape;
  readonly kind: RuntimeEventKind;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly payload: unknown;
}

export interface RuntimeCancellationResult {
  readonly ref: AgentTurnRefShape;
  readonly requestedLevel: 'graceful' | 'hard';
  readonly confirmedLevel?: 'graceful' | 'hard' | undefined;
  readonly status: 'confirmed' | 'unknown';
}

export interface AgentRuntimeCapabilitiesShape {
  readonly provider: AgentProviderLabel;
  readonly providerServerId?: string | undefined;
  readonly providerVersion: string;
  readonly serverVersion: string;
  readonly verifiedCapabilities: readonly string[];
  readonly verifiedAt: string;
  readonly digest: string;
}

/**
 * The full provider-neutral AgentRuntime port. Composition root supplies a
 * concrete implementation backed by a verified TrueForge client (C036 §10).
 */
export interface AgentRuntime {
  capabilities(): Promise<AgentRuntimeCapabilitiesShape>;
  createSession(input: CreateAgentSessionInput): Promise<AgentSessionRefShape>;
  getSession(ref: AgentSessionRefShape): Promise<AgentSessionObservation>;
  createTurn(input: CreateAgentTurnInput): Promise<AgentTurnRefShape>;
  getTurn(ref: AgentTurnRefShape): Promise<AgentTurnObservation>;
  streamEvents(input: StreamAgentEventsInput): AsyncIterable<RuntimeEventEnvelope>;
  submitRequiredActionResult(input: RequiredActionResultInput): Promise<AgentTurnRefShape>;
  cancel(input: CancelRuntimeWorkInput): Promise<RuntimeCancellationResult>;
}

function correlationSchema(): z.ZodType<CorrelationShape> {
  return correlation;
}

export const runtimeContracts = {
  agentSessionRefSchema,
  agentTurnRefSchema,
  createAgentSessionInputSchema,
  createAgentTurnInputSchema,
  streamAgentEventsInputSchema,
  requiredActionResultSchema,
  cancelRuntimeWorkSchema,
  runtimeEventKindSchema,
  sessionObservationStatusSchema,
  turnObservationStatusSchema,
  providerIdSchema,
};
export { providerIdSchema };
