/**
 * @devguard/api — HTTP transport and composition root.
 *
 * C001 boundary: this app composes packages; it must not contain domain logic.
 */
export { assembleApi, type AssembledApi } from './app.js';
export {
  buildContainer,
  validateReadiness,
  InMemoryAuthorizationEvidenceStore,
  type ReadinessOptions,
} from './composition/container.js';
export type { ApiContainer, CompositionBindings } from './composition/container.js';
// CP002 binding marker + volatile-adapters matrix (test/diagnostics).
export {
  isVolatileBinding,
  VOLATILE_BINDING_KIND,
  PORT_FAMILIES,
  type PortFamily,
  type VolatileBindingMarker,
} from './composition/bindings.js';
export {
  UnavailableWorkflowAdapter,
  VolatileApprovals,
  VolatileArtifacts,
  VolatileAudit,
  VolatileFindings,
  VolatilePolicySummaries,
  VolatileRepositoryCatalog,
  VolatileSessionEvents,
  VolatileWebhookAcceptance,
  VolatileWorkflowService,
  type WorkflowPorts,
} from './composition/volatile-adapters.js';
export { createRequestContext, createTransportKernel, RATE_LIMITS } from './transport/kernel.js';
export type {
  AppEnv,
  AuthClass,
  RateLimitClass,
  RateLimiterPort,
  RequestContext,
  RegisterV1Route,
  RouteHandler,
  RouteMetadata,
} from './transport/kernel.js';
export { InMemoryRateLimiter, RedisRateLimiter } from './transport/rate-limit.js';
export { ConnectionRegistry, createSseResponse, parseLastEventId } from './transport/sse.js';
export type { SseConnection } from './transport/sse.js';
export { API_APP_NAME, API_APP_VERSION } from './index.core.js';
