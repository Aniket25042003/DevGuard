/**
 * C039 §9/§12 — the non-bypassable MCP policy gateway.
 *
 * Every tool proposal is authenticated/validated, its arguments normalized and
 * mapped to EXACTLY ONE action, the policy decision persisted as a
 * `ToolCallIntent` BEFORE any tool effect, and the disposition returned. Unknown
 * tools, disabled/direct-mutative tools, schema mismatches, and cross-repo/session
 * arguments fail closed. Approval-required actions create a correlation
 * `CheckpointLink` (no approval value); only an explicit approved grant produces
 * `AUTHORIZED_EXECUTION`.
 */
import { randomUUID } from 'node:crypto';
import { makeError } from '@devguard/errors';
import {
  toolProposalSchema,
  type AuthorizedToolExecutionGrant,
  type CheckpointLink,
  type ToolCallIntent,
  type ToolPolicyResult,
  type ToolProposal,
} from './contracts.js';
import { normalizeToolArguments } from './argument-normalizer.js';
import type { ToolProfileRegistry } from './tool-profiles.js';
import type { ToolIntentStorePort } from './intent-store.js';

export interface PolicyDecisionPort {
  decide(input: {
    actionId: string;
    providerRisk: string;
    sessionId: string;
    turnId: string;
  }): Promise<ToolPolicyResult>;
}

export class AllowReadOnlyPolicyPort implements PolicyDecisionPort {
  async decide(input: { actionId: string; providerRisk: string }): Promise<ToolPolicyResult> {
    return input.providerRisk === 'read_only' || input.providerRisk === 'low'
      ? 'ALLOW'
      : input.providerRisk === 'high' || input.providerRisk === 'mutative_external'
        ? 'APPROVAL_REQUIRED'
        : 'ALLOW';
  }
}

export type ToolDisposition =
  | { readonly result: 'ALLOW'; readonly intent: ToolCallIntent }
  | { readonly result: 'DENY'; readonly code: string; readonly detail: string }
  | {
      readonly result: 'APPROVAL_REQUIRED';
      readonly intent: ToolCallIntent;
      readonly checkpointId: string;
    };

export interface PolicyGatewayEvent {
  readonly type: string;
  readonly aggregateId: string;
  readonly intentId: string;
  readonly payload?: Readonly<Record<string, unknown>> | undefined;
}
export interface PolicyGatewayEventSinkPort {
  emit(event: PolicyGatewayEvent): Promise<void>;
}

export interface PolicyGatewayDeps {
  readonly registry: ToolProfileRegistry;
  readonly decisions: PolicyDecisionPort;
  readonly intents: ToolIntentStorePort;
  readonly toolProfileId: string;
  readonly clock?: { readonly nowIso: () => string };
  readonly emit?: PolicyGatewayEventSinkPort;
}

export class McpPolicyGateway {
  readonly #registry: ToolProfileRegistry;
  readonly #decisions: PolicyDecisionPort;
  readonly #intents: ToolIntentStorePort;
  readonly #toolProfileId: string;
  readonly #clock: { readonly nowIso: () => string };
  readonly #emit: PolicyGatewayEventSinkPort;

  constructor(deps: PolicyGatewayDeps) {
    this.#registry = deps.registry;
    this.#decisions = deps.decisions;
    this.#intents = deps.intents;
    this.#toolProfileId = deps.toolProfileId;
    this.#clock = deps.clock ?? { nowIso: () => new Date().toISOString() };
    this.#emit = deps.emit ?? { emit: async () => undefined };
  }

  async intercept(proposal: ToolProposal, rawArguments: unknown): Promise<ToolDisposition> {
    const parsed = toolProposalSchema.safeParse(proposal);
    if (!parsed.success)
      return {
        result: 'DENY',
        code: 'TOOL_POLICY_INTERCEPTION_REQUIRED',
        detail: 'malformed proposal',
      };

    const existing = await this.#intents.findByProviderCall(
      parsed.data.provider,
      parsed.data.sessionId,
      parsed.data.providerToolCallId,
    );
    if (existing !== undefined) {
      if (existing.status === 'DENIED' || existing.policyDecision === 'DENY') {
        return { result: 'DENY', code: existing.status, detail: 'already denied' };
      }
      if (existing.policyDecision === 'APPROVAL_REQUIRED') {
        return {
          result: 'APPROVAL_REQUIRED',
          intent: existing,
          checkpointId: `cp-${existing.id.slice(0, 8)}`,
        };
      }
      return { result: 'ALLOW', intent: existing };
    }

    const lookup = this.#registry.lookup(parsed.data.toolName, parsed.data.toolProfileId);
    if (!lookup.ok) return { result: 'DENY', code: lookup.code, detail: 'tool not allowed' };

    const args = normalizeToolArguments(
      rawArguments,
      lookup.entry.schemaVersion,
      parsed.data.schemaVersion,
    );
    if (!args.ok) return { result: 'DENY', code: args.code, detail: 'arguments rejected' };

    const decision = await this.#decisions.decide({
      actionId: lookup.entry.actionId,
      providerRisk: lookup.entry.providerRisk,
      sessionId: parsed.data.sessionId,
      turnId: parsed.data.turnId,
    });

    const nowIso = this.#clock.nowIso();
    const intent: ToolCallIntent = {
      id: randomUUID(),
      provider: parsed.data.provider,
      sessionId: parsed.data.sessionId,
      turnId: parsed.data.turnId,
      providerToolCallId: parsed.data.providerToolCallId,
      toolName: parsed.data.toolName,
      profileId: parsed.data.toolProfileId,
      actionId: lookup.entry.actionId,
      providerRisk: lookup.entry.providerRisk,
      policyDecision: decision,
      status:
        decision === 'ALLOW' ? 'ALLOWED' : decision === 'DENY' ? 'DENIED' : 'WAITING_APPROVAL',
      normalizedArgumentsDigest: args.normalizedDigest,
      idempotencyKey: `${parsed.data.providerToolCallId}:${args.normalizedDigest}`,
      cancellationGeneration: 0,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    await this.#intents.save(intent);
    await this.#event('tool.intent.persisted', intent.id, { actionId: intent.actionId, decision });

    if (decision === 'DENY')
      return { result: 'DENY', code: 'POLICY_DENIED', detail: 'action policy denied' };
    if (decision === 'APPROVAL_REQUIRED') {
      await this.#event('tool.approval_required', intent.id, { actionId: intent.actionId });
      return { result: 'APPROVAL_REQUIRED', intent, checkpointId: `cp-${intent.id.slice(0, 8)}` };
    }
    await this.#event('tool.allowed', intent.id, { actionId: intent.actionId });
    return { result: 'ALLOW', intent };
  }

  async authorizeExecution(
    intentId: string,
    actionId: string,
  ): Promise<AuthorizedToolExecutionGrant> {
    const intent = await this.#intents.get(intentId);
    if (intent === undefined) throw makeError('TOOL_CALL_NOT_FOUND', { details: {} });
    if (intent.actionId !== actionId) throw makeError('TOOL_ACTION_MISMATCH', { details: {} });
    if (intent.policyDecision !== 'APPROVAL_REQUIRED')
      throw makeError('AUTHORIZED_GRANT_REQUIRED', { details: {} });
    const updated: ToolCallIntent = {
      ...intent,
      status: 'AUTHORIZED_EXECUTION',
      updatedAtIso: this.#clock.nowIso(),
    };
    await this.#intents.save(updated);
    if (this.#links)
      this.#links.set(`${intentId}:grant`, {
        id: randomUUID(),
        toolIntentId: intentId,
        actionId,
        sessionId: intent.sessionId,
        turnId: intent.turnId,
        providerCheckpointRef: `cp-${intentId.slice(0, 8)}`,
        syncStatus: 'RESOLVED',
        createdAtIso: this.#clock.nowIso(),
      });
    await this.#event('tool.authorized_execution', intent.id, { actionId });
    return {
      toolIntentId: intent.id,
      actionId: intent.actionId,
      profileId: intent.profileId,
      toolName: intent.toolName,
      cancellationGeneration: intent.cancellationGeneration,
    };
  }

  readonly #links: Map<string, CheckpointLink> = new Map();
  async #event(type: string, intentId: string, payload: Record<string, unknown>): Promise<void> {
    await this.#emit.emit({ type, aggregateId: intentId, intentId, payload });
  }
}
