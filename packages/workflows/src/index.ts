/**
 * @devguard/workflows — ships the C051 `security_audit` product workflow
 * definition (a C045-style build asset).
 */
export {
  SECURITY_AUDIT_STEPS,
  SECURITY_AUDIT_ALLOWED_ACTIONS,
  SECURITY_AUDIT_DEFINITION_ID,
  SECURITY_AUDIT_DEFINITION_VERSION,
  securityAuditDefinition,
  validateDefinition,
  type AuditStep,
  type DefinitionValidation,
} from './product/security-audit.js';
