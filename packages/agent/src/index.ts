/**
 * @devguard/agent — TrueForge AgentRuntime contract verification adapter (C036).
 *
 * Provider-neutral application layer (rationalized in PR #30 Open decisions):
 * the TrueForge adapter and the provider-neutral runtime contracts are merged
 * into a single `packages/agent` package so domain/application code depends on
 * one boundary. External providers and policy/approval wiring reach this
 * package only through typed ports owned here; the composition root (apps)
 * supplies concrete implementations. Provider SDK types never cross this
 * boundary, and Qodo has no runtime role or dependency in it.
 *
 * C036 scope: capability matrix, compatibility FSM, contract snapshots,
 * verification probes, provider redaction/mapping, and the startup preflight
 * gate. Session/turn orchestration (C037), event normalization (C038), MCP
 * interception (C039), and context/subagent/cancellation (C040) build on this.
 */
export { agentIdSchemas } from './ids.js';
export type {
  ContractSnapshotId,
  VerificationRunId,
  RequiredActionId,
  ProviderServerId,
  ProviderRef,
  Brand,
} from './ids.js';

export {
  AGENT_CAPABILITIES,
  ALL_AGENT_CAPABILITIES,
  MANDATORY_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
  FATAL_PROVIDER_PROPERTIES,
  evaluateCapabilities,
  isKnownCapability,
} from './capabilities.js';
export type {
  AgentCapability,
  CapabilityClaim,
  CapabilityEvaluation,
  CapabilityVerdict,
  FatalProviderProperty,
} from './capabilities.js';

export {
  COMPATIBILITY_STATUSES,
  OPERATIONAL_STATUSES,
  isOperational,
  verdictToStatus,
  resolveEdge,
  allCompatibilityPairs,
} from './compatibility.js';
export type {
  CompatibilityStatus,
  CompatibilityTrigger,
  TransitionGuardContext,
  TransitionVerdict,
} from './compatibility.js';

export {
  KNOWN_PROVIDERS,
  isKnownProvider,
  CORRELATION_HEADER_KEY,
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
} from './contracts.js';
export type {
  AgentProviderLabel,
  AgentSessionRefShape,
  AgentTurnRefShape,
  CreateAgentSessionInput,
  CreateAgentTurnInput,
  StreamAgentEventsInput,
  RequiredActionResultInput,
  CancelRuntimeWorkInput,
  AgentSessionObservation,
  AgentTurnObservation,
  RuntimeEventEnvelope,
  RuntimeEventKind,
  RuntimeCancellationResult,
  AgentRuntimeCapabilitiesShape,
  AgentRuntime,
} from './contracts.js';

export {
  AGENT_EVENT_TYPES,
  AGENT_EVENT_CATALOG,
  registerAgentEvents,
  makeAgentEvent,
} from './events.js';
export type { AgentEventType, MakeAgentEventInput } from './events.js';

export {
  AGENT_CAPABILITY_SUITE_VERSION,
  providerIdentificationSchema,
  contractSnapshotSchema,
  snapshotDigest,
  verificationRunKey,
  snapshotId,
  isSnapshotFresh,
} from './snapshot.js';
export type { ProviderIdentification, ContractSnapshot } from './snapshot.js';

export {
  identificationReportSchema,
  probeResultSchema,
  normalizeProbeResult,
  normalizeIdentification,
  classifyProviderError,
} from './mapper.js';
export type {
  NormalizedProviderIdentification,
  NormalizedProbeResult,
  ProviderErrorClassification,
} from './mapper.js';

export {
  redactProviderPayload,
  redactInlineSecrets,
  REDACTION_MASK,
  SECRET_KEY_PATTERN,
} from './redact.js';

export {
  systemClock,
  systemIds,
  VERIFICATION_PROBE_IDS,
  VERIFICATION_PROBE_SUITE,
  InMemorySnapshotStore,
} from './ports.js';
export type {
  AgentClock,
  AgentIdGenerator,
  VerificationProbeId,
  VerificationProbeSpec,
  RawProviderChannel,
  RawIdentificationReport,
  SnapshotStorePort,
} from './ports.js';

import './errors.js';

export { createContractVerifier, DEFAULT_SNAPSHOT_TTL_MS } from './verifier.js';
export type {
  AgentClockPort,
  AgentIdPort,
  EmitAgentEvent,
  ContractVerifierDeps,
  ContactVerifierOptions,
  ContractVerifierResult,
} from './verifier.js';

export { createStartupPreflight, detectDigestDrift, observedDigestFor } from './preflight.js';
export type { StartupPreflightDeps, PreflightResult, StartupPreflight } from './preflight.js';
