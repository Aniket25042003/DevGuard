/**
 * @devguard/worker — background job runtime composition.
 *
 * C001 boundary: this app composes packages; it must not contain domain logic.
 */
export {
  buildWorkerContainer,
  validateWorkerReadiness,
  workerStartupStatus,
} from './composition/container.js';
export type { WorkerContainer, WorkerStartupStatus } from './composition/container.js';
export { WORKER_APP_NAME, WORKER_APP_VERSION } from './index.core.js';
