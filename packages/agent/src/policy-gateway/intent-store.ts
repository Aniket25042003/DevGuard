/**
 * C039 §9/§13 — tool-call intent store (idempotent by provider tool-call id).
 */
import type { ToolCallIntent } from './contracts.js';

export interface ToolIntentStorePort {
  get(id: string): Promise<ToolCallIntent | undefined>;
  findByProviderCall(
    provider: string,
    sessionId: string,
    providerToolCallId: string,
  ): Promise<ToolCallIntent | undefined>;
  save(intent: ToolCallIntent): Promise<void>;
}

export class InMemoryToolIntentStore implements ToolIntentStorePort {
  readonly intents = new Map<string, ToolCallIntent>();
  readonly byCall = new Map<string, ToolCallIntent>();

  key(provider: string, sessionId: string, callId: string): string {
    return JSON.stringify([provider, sessionId, callId]);
  }

  async get(id: string): Promise<ToolCallIntent | undefined> {
    return this.intents.get(id);
  }
  async findByProviderCall(
    provider: string,
    sessionId: string,
    providerToolCallId: string,
  ): Promise<ToolCallIntent | undefined> {
    return this.byCall.get(this.key(provider, sessionId, providerToolCallId));
  }
  async save(intent: ToolCallIntent): Promise<void> {
    this.intents.set(intent.id, intent);
    this.byCall.set(this.key(intent.provider, intent.sessionId, intent.providerToolCallId), intent);
  }
}
