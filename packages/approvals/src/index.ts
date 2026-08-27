/**
 * @devguard/approvals — durable approval aggregate domain (C031–C035).
 *
 * Boundary rule: PostgreSQL/DevGuard is the approval system of record;
 * TrueForge checkpoints only pause runtime execution. No provider SDK types
 * cross this package; observations arrive as validated DevGuard snapshots.
 */
export {
  APPROVAL_STATUSES,
  TERMINAL_STATUSES,
  allPairs,
  isTerminal,
  resolveEdge,
  type ApprovalStatus,
  type ApprovalTrigger,
  type TransitionGuardContext,
  type TransitionVerdict,
} from './domain/approval-fsm.js';

export {
  CanonicalizationError,
  canonicalize,
  fingerprint,
  sha256Hex,
} from './fingerprint/canonical.js';
export {
  approvalActionV1,
  approvalContextV1,
  buildFingerprints,
  validationEvidenceRef,
  type ActionFingerprintResult,
  type ApprovalActionV1,
  type ApprovalContextV1,
} from './fingerprint/schemas.js';

export {
  ApprovalCreationError,
  ApprovalFactory,
  FINGERPRINT_SCHEMA_VERSION,
  toDbStatus,
  type ApprovalRepositoryPort,
  type CreateApprovalRequest,
  type CreatedApproval,
} from './application/create-approval.js';
