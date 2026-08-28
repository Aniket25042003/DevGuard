/**
 * C022 §10/§12/§20 — webhook trigger router.
 *
 * Routes only policy-matched triggers into idempotent command keys. It NEVER
 * executes workflows or provider writes inline. The semantic key
 * `(repository, trigger version, subject immutable id|headSha, semantic event)`
 * guarantees at-most-one workflow command per real transition.
 */
import type { NormalizedWebhookEvent } from './contracts.js';

export interface WebhookTriggerDefinition {
  readonly triggerId: string;
  readonly workflowKind: string;
  readonly events: readonly string[];
  readonly actions?: readonly string[] | undefined;
}

export interface RoutedTrigger {
  readonly deliveryId: string;
  readonly triggerId: string;
  readonly workflowKind: string;
  readonly repositoryId: string;
  readonly semanticKey: string;
}

export type RoutingResult =
  | { readonly matched: true; readonly routes: readonly RoutedTrigger[] }
  | { readonly matched: false; readonly reason: 'NO_TRIGGER' | 'WALLET_MISSING' };

export interface TriggerRouterDeps {
  readonly triggers: readonly WebhookTriggerDefinition[];
}

export class TriggerRouter {
  constructor(private readonly deps: TriggerRouterDeps) {}

  route(event: NormalizedWebhookEvent, deliveryId: string): RoutingResult {
    const repository = event.repository;
    if (repository === undefined) return { matched: false, reason: 'WALLET_MISSING' };
    const routes: RoutedTrigger[] = [];
    for (const trigger of this.deps.triggers) {
      if (!trigger.events.includes(event.event)) continue;
      if (
        trigger.actions !== undefined &&
        event.action !== undefined &&
        !trigger.actions.includes(event.action)
      )
        continue;
      const subject =
        event.headSha ??
        (event.prNumber !== undefined
          ? `pr:${event.prNumber}`
          : event.issueNumber !== undefined
            ? `issue:${event.issueNumber}`
            : repository.providerRepositoryId);
      const semanticKey = `${repository.providerRepositoryId}/${trigger.triggerId}/${subject}/${event.event}${event.action !== undefined ? `:${event.action}` : ''}`;
      routes.push({
        deliveryId,
        triggerId: trigger.triggerId,
        workflowKind: trigger.workflowKind,
        repositoryId: repository.providerRepositoryId,
        semanticKey,
      });
    }
    return routes.length > 0 ? { matched: true, routes } : { matched: false, reason: 'NO_TRIGGER' };
  }
}
