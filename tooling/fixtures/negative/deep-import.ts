/**
 * Negative fixture: cross-package deep imports MUST fail type resolution.
 * Expected: TS reports an unresolved module error for '@devguard/errors/src/…'
 * because the package exports map exposes only the '.' entry point.
 */
import { ERRORS_PACKAGE_VERSION } from '@devguard/errors/src/deep.js';

export const version: string = ERRORS_PACKAGE_VERSION;
