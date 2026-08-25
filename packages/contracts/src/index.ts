/**
 * @devguard/contracts — canonical provider-neutral domain contracts (C004).
 *
 * Boundary rule: schemas and types ONLY. No behavior, no provider SDK types,
 * no persistence row shapes. Owning components implement transitions and emit
 * registered events through versioned envelopes.
 */

// Primitives
export {
  boundedText,
  exhaustiveMatch,
  schemas as idSchemas,
  rowVersion,
  sequence,
  timestampIso,
} from './primitives.js';
export type {
  ActionId,
  AgentSessionRefId,
  ApprovalId,
  ArtifactId,
  AuditRecordId,
  DeliveryId,
  EventId,
  InstallationId,
  OperationKey,
  PolicyDecisionId,
  PolicyVersionId,
  RepositoryId,
  RowVersion,
  SecurityFindingId,
  TimestampIso,
  TurnRefId,
  UserId,
  ValidationResultId,
  WorkflowDefinitionId,
  WorkflowRunId,
  WorkflowStepId,
} from './primitives.js';

// Context
export {
  actorRef,
  correlation,
  DataClassification,
  externalRef,
  provenance,
  ProvenanceSource,
} from './context.js';
export type {
  ActorKind,
  ActorRefShape,
  CorrelationShape,
  ExternalRefShape,
  ProvenanceShape,
} from './context.js';

// Repositories & identity
export { connectedRepository, RepositoryLifecycleStatus, userPrincipal } from './repositories.js';
export type { ConnectedRepositoryShape, UserPrincipalShape } from './repositories.js';

// Policy & actions
export {
  ActionType,
  actionProposal,
  AutonomyLevel,
  ExecutionEnvironment,
  Obligation,
  PolicyEffect,
  policyDecisionShape,
  RiskClass,
  toolBinding,
} from './policy.js';
export type { ActionProposalShape, PolicyDecisionShape, ToolBindingShape } from './policy.js';

// Workflows & sessions
export {
  agentSessionRef,
  StepStatus,
  workflowCompletion,
  WorkflowKind,
  workflowRun,
  WorkflowStatus,
  WORKFLOW_TERMINAL_STATUSES,
} from './workflows.js';
export type {
  AgentSessionRefShape,
  TriggerKind,
  WorkflowCompletionShape,
  WorkflowRunShape,
} from './workflows.js';

// Approvals
export {
  approvalFingerprintInput,
  ApprovalStatus,
  approvalRequest,
  APPROVAL_TERMINAL_STATUSES,
} from './approvals.js';
export type {
  ApprovalFingerprintInputShape,
  ApprovalRequestShape,
  ApprovalTerminalStatus,
} from './approvals.js';

// Evidence
export {
  artifact,
  FindingSeverity,
  FindingStatus,
  securityFinding,
  validationResult,
  ValidationStatus,
  ValidatorKind,
} from './evidence.js';
export type { ArtifactShape, SecurityFindingShape, ValidationResultShape } from './evidence.js';

// Events
export {
  EVENT_SCHEMA_VERSION,
  eventEnvelopeBase,
  getRegisteredEvent,
  listRegisteredEventTypes,
  makeEvent,
  parseEvent,
  registerEvent,
} from './events.js';
export type {
  EventAggregateShape,
  EventEnvelopeShape,
  MakeEventInput,
  ParsedEvent,
  RegisteredEvent,
} from './events.js';

// Public projections
export { publicApprovalView, publicWorkflowRunSummary } from './public.js';
export type { PublicApprovalView, PublicWorkflowRunSummary } from './public.js';
