/**
 * @devguard/workflows — ships the C054 `review_remediation` product workflow
 * definition (a C045-style build asset).
 */
export {
  REVIEW_REMEDIATION_STEPS,
  REVIEW_REMEDIATION_ALLOWED_ACTIONS,
  REVIEW_REMEDIATION_CYCLE_BUDGET,
  REVIEW_REMEDIATION_DEFINITION_ID,
  REVIEW_REMEDIATION_DEFINITION_VERSION,
  reviewRemediationDefinition,
  validateDefinition,
  type DefinitionValidation,
  type ReviewStep,
} from './product/review-remediation.js';
