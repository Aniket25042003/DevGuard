/**
 * @devguard/workflows — ships the C050 `diagnose_failure` product workflow
 * definition (a C045-style build asset).
 */
export {
  DIAGNOSE_FAILURE_STEPS,
  DIAGNOSE_FAILURE_ALLOWED_ACTIONS,
  DIAGNOSE_FAILURE_DEFINITION_ID,
  DIAGNOSE_FAILURE_DEFINITION_VERSION,
  diagnoseFailureDefinition,
  validateDefinition,
  type DefinitionValidation,
  type FailureStep,
} from './product/diagnose-failure.js';
