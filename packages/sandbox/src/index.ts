/**
 * @devguard/sandbox — Isolated command execution sandbox (C041-C044):
 * fail-closed workspace checkout, authorized timed commands (C042), resource/
 * egress limits (C043) and secure artifact cleanup (C044).
 *
 * Provider-neutral application layer. External providers (TrueForge), the
 * GitHub read adapter, policy/approval and SQL persistence reach this package
 * only through typed ports owned here; the composition root (apps) supplies
 * concrete implementations. Provider SDK types and row shapes never cross
 * this boundary. C042 (command execution) is implemented in a follow-on PR.
 */

// Register sandbox error codes when the package is loaded.
import './errors.js';

// Branded identifiers + schemas.
export {
  brand,
  outputSequence,
  sandboxIdSchemas,
  type Brand,
  type CapabilitySnapshotId,
  type CheckoutAttestationId,
  type CommandId,
  type LimitProfileId,
  type ProviderCommandId,
  type ProviderWorkspaceId,
  type WorkspaceId,
} from './ids.js';

// Workspace checkout — workspace FSM (exhaustive, fail-closed guards).
export {
  isTerminalWorkspace,
  isLegalWorkspaceEdge,
  resolveWorkspaceEdge,
  transitionWorkspace,
  workspaceCleanupRequired,
  WORKSPACE_CLEANUP_REQUIRED_STATUSES,
  WORKSPACE_STATUSES,
  WORKSPACE_TERMINAL_STATUSES,
  type WorkspaceStatus,
  type WorkspaceTransitionGuards,
  type WorkspaceTransitionVerdict,
  type WorkspaceTrigger,
} from './workspaces/fsm.js';

// Durable aggregate shapes + boundary guards.
export {
  isWellFormedRecordId,
  WELL_FORMED_ID_PATTERN,
  type WorkspaceLeaseRenewal,
  type WorkspaceRecord,
  type WorkspaceReservation,
  type WorkspaceTransitionInput,
  type WorkspaceTransitionPatch,
  type WorkspaceTransitionResult,
} from './workspaces/state.js';

// Checkout selector validation and ref resolution.
export {
  checkoutSelectorSchema,
  describeSelector,
  expectedShaOf,
  fullShaSchema,
  FULL_SHA_PATTERN,
  parseCheckoutSelector,
  parseResolvedCheckout,
  REF_KINDS,
  type CheckoutSelector,
  type RefKind,
  type ResolvedCheckout,
  type ResolvedCheckoutInput,
  type ValidationIssue,
} from './workspaces/selector.js';

// Capability gate (fail closed on unknown/unverified claims).
export {
  capabilitySnapshotId,
  DEFAULT_WORKSPACE_CAPABILITY_PROFILE,
  providerCapabilityManifestSchema,
  requireWorkspaceCapabilities,
  WORKSPACE_CAPABILITY_NAMES,
  type CapabilityDecision,
  type ProviderCapabilityClaim,
  type ProviderCapabilityManifest,
  type WorkspaceCapability,
  type WorkspaceCapabilityProfile,
} from './workspaces/capability-gate.js';

// Fencing / leases.
export {
  assertFenceCurrent,
  isLeaseExpired,
  newLeaseToken,
  parseWorkspaceFence,
  workspaceFenceSchema,
  type WorkspaceFence,
} from './workspaces/fence.js';

// Safe bootstrap checkout policy (structural no-host-checkout invariant).
export {
  ALLOWED_CHECKOUT_HOST,
  assertNoHostCheckout,
  buildSafeCheckoutPlan,
  SAFE_GIT_DIRECTIVES,
  type CheckoutExecution,
  type SafeCheckoutPlan,
  type SafeCheckoutPlanInput,
} from './workspaces/safe-git.js';

// Checkout verification + attestation (READY requires exact SHA equality).
export {
  buildAttestation,
  verifyCheckout,
  type AttestationInput,
  type CheckoutAttestation,
  type CheckoutMismatchKind,
  type CheckoutObservation,
  type VerificationOutcome,
} from './workspaces/verifier.js';

// Stable provider idempotency keys.
export {
  assertWorkspaceKeyShape,
  isWorkspaceCreationKey,
  isWorkspaceDestroyKey,
  workspaceCreationKey,
  workspaceDestroyKey,
} from './workspaces/idempotency.js';

// Provider-neutral ports the composition root implements.
export {
  type CapabilityProbePort,
  type CheckoutVerifierPort,
  type CurrentFence,
  type ProviderDestroyResult,
  type ProviderWorkspaceCreateResult,
  type ProviderWorkspaceSnapshot,
  type RefResolverPort,
  type SandboxEventPort,
  type TrueForgeWorkspacePort,
  type WorkspaceManagerPorts,
  type WorkspaceStorePort,
} from './workspaces/ports.js';

// Orchestration.
export {
  DESTROY_REASONS,
  WorkspaceManager,
  type CreateWorkspaceInput,
  type DestroyOutcome,
  type DestroyReason,
  type WorkspaceManagerOptions,
  type WorkspaceRef,
  type WorkspaceStatusView,
} from './workspaces/manager.js';

// Event catalog + envelope builder.
export {
  makeSandboxEvent,
  registerSandboxEvents,
  SANDBOX_EVENT_CATALOG,
  SANDBOX_EVENT_TYPES,
  type MakeSandboxEventInput,
  type SandboxEventCatalogEntry,
  type SandboxEventType,
} from './events.js';

// Redaction helper (secrets never logged/persisted).
export { redactValue } from './redact.js';
