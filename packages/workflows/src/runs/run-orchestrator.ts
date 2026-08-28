/**
 * C046 §12/§13/§20 — WorkflowRunOrchestrator.
 *
 * Launches a run bound to an exact immutable definition snapshot (idempotent by
 * idempotencyKey), advances ordered step templates through the run/step FSMs,
 * and completes/fails/cancels the run. Converters bind registry definitions to
 * runs without provider types.
 */
import { randomUUID } from 'node:crypto';
import { makeError } from '@devguard/errors';
import {
  runSchema,
  type LaunchWorkflowInput,
  type RunState,
  type StepState,
  type WorkflowRun,
  type WorkflowRunStep,
} from './contracts.js';
import { resolveRunEdge, resolveStepEdge, type RunTrigger, type StepTrigger } from './fsm.js';
import type { WorkflowDefinition, WorkflowDefinitionSnapshot } from '../definitions/contracts.js';

export interface RunStorePort {
  get(id: string): Promise<WorkflowRun | undefined>;
  findByIdempotency(key: string): Promise<WorkflowRun | undefined>;
  save(run: WorkflowRun): Promise<void>;
}

export class InMemoryRunStore implements RunStorePort {
  readonly runs = new Map<string, WorkflowRun>();
  readonly byKey = new Map<string, WorkflowRun>();
  async get(id: string): Promise<WorkflowRun | undefined> {
    return this.runs.get(id);
  }
  async findByIdempotency(key: string): Promise<WorkflowRun | undefined> {
    return this.byKey.get(key);
  }
  async save(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, run);
    this.byKey.set(run.idempotencyKey, run);
  }
}

export interface RunOrchestratorDeps {
  readonly store: RunStorePort;
  readonly resolveDefinition: (id: string, version: string) => WorkflowDefinition;
  readonly snapshotDefinition: (id: string, version: string) => WorkflowDefinitionSnapshot;
  readonly clock?: { readonly nowIso: () => string };
}

export type LaunchResult = {
  readonly ok: true;
  readonly run: WorkflowRun;
  readonly replayed: boolean;
};

export class WorkflowRunOrchestrator {
  readonly #store: RunStorePort;
  readonly #resolve: (id: string, version: string) => WorkflowDefinition;
  readonly #snapshot: (id: string, version: string) => WorkflowDefinitionSnapshot;
  readonly #clock: { readonly nowIso: () => string };

  constructor(deps: RunOrchestratorDeps) {
    this.#store = deps.store;
    this.#resolve = deps.resolveDefinition;
    this.#snapshot = deps.snapshotDefinition;
    this.#clock = deps.clock ?? { nowIso: () => new Date().toISOString() };
  }

  async launch(input: LaunchWorkflowInput): Promise<LaunchResult> {
    const existing = await this.#store.findByIdempotency(input.idempotencyKey);
    if (existing !== undefined) return { ok: true, run: existing, replayed: true };

    const definition = this.#resolve(input.workflowDefinitionId, input.definitionVersion);
    const snapshot = this.#snapshot(input.workflowDefinitionId, input.definitionVersion);
    const nowIso = this.#clock.nowIso();
    const run: WorkflowRun = {
      id: randomUUID(),
      workflowRunId: input.workflowRunId,
      repositoryId: input.repositoryId,
      definitionSnapshotId: snapshot.id,
      state: 'PENDING',
      currentStepIndex: 0,
      steps: definition.steps.map((step, index) => ({
        templateId: step.id,
        kind: step.kind,
        state: 'PENDING' as StepState,
        attempts: 0,
        ...(index === 0 ? {} : {}),
      })),
      idempotencyKey: input.idempotencyKey,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    runSchema.parse(run);
    await this.#store.save(run);
    return { ok: true, run, replayed: false };
  }

  async transitionRun(runId: string, trigger: RunTrigger): Promise<WorkflowRun> {
    const run = await this.#store.get(runId);
    if (run === undefined) throw makeError('RUN_NOT_FOUND', { details: {} });
    const edge = resolveRunEdge(run.state, trigger);
    if (!edge.allowed) throw makeError('RUN_ILLEGAL_TRANSITION', { details: {} });
    const next: WorkflowRun = { ...run, state: edge.to, updatedAtIso: this.#clock.nowIso() };
    await this.#store.save(next);
    return next;
  }

  async transitionStep(
    runId: string,
    stepIndex: number,
    trigger: StepTrigger,
  ): Promise<WorkflowRun> {
    const run = await this.#store.get(runId);
    if (run === undefined) throw makeError('RUN_NOT_FOUND', { details: {} });
    const step = run.steps[stepIndex];
    if (step === undefined) throw makeError('STEP_NOT_FOUND', { details: {} });
    const edge = resolveStepEdge(step.state, trigger);
    if (!edge.allowed) throw makeError('STEP_ILLEGAL_TRANSITION', { details: {} });
    const updated: WorkflowRunStep = { ...step, state: edge.to, attempts: step.attempts + 1 };
    const steps = run.steps.map((s, i) => (i === stepIndex ? updated : s));
    const next: WorkflowRun = { ...run, steps, updatedAtIso: this.#clock.nowIso() };
    await this.#store.save(next);
    return next;
  }

  async currentStep(runId: string): Promise<WorkflowRunStep | undefined> {
    const run = await this.#store.get(runId);
    return run?.steps[run.currentStepIndex];
  }

  runState(binding: { state: string }): RunState {
    return binding.state as RunState;
  }
}
