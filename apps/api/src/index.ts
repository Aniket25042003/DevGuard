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
} from './composition/container.js';
export type { ApiContainer, CompositionBindings } from './composition/container.js';
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
export { InMemoryRateLimiter } from './transport/rate-limit.js';
export { ConnectionRegistry, createSseResponse, parseLastEventId } from './transport/sse.js';
export type { SseConnection } from './transport/sse.js';
export { API_APP_NAME, API_APP_VERSION } from './index.core.js';
