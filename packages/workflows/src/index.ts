/**
 * @devguard/workflows — ships the C052 `security_patch` product workflow
 * definition (a C045-style build asset).
 */
export {
  SECURITY_PATCH_STEPS,
  SECURITY_PATCH_ALLOWED_ACTIONS,
  SECURITY_PATCH_DEFINITION_ID,
  SECURITY_PATCH_DEFINITION_VERSION,
  securityPatchDefinition,
  validateDefinition,
  type DefinitionValidation,
  type PatchStep,
} from './product/security-patch.js';
