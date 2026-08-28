/**
 * @devguard/workflows — Durable workflow engine. This PR ships the C049
 * `implement_issue` product workflow definition (a C045-style build asset).
 */
export {
  IMPLEMENT_ISSUE_STEPS,
  IMPLEMENT_ISSUE_ALLOWED_ACTIONS,
  IMPLEMENT_ISSUE_ARTIFACTS,
  IMPLEMENT_ISSUE_DEFINITION_ID,
  IMPLEMENT_ISSUE_DEFINITION_VERSION,
  IMPLEMENT_ISSUE_REQUIRED_CAPABILITIES,
  implementIssueDefinition,
  validateDefinition,
  type DefinitionValidation,
  type ProductStep,
} from './product/implement-issue.js';
