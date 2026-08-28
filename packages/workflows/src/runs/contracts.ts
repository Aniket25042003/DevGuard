/**
 * C046 §8/§9 — workflow run + step orchestration contracts.
 *
 * A run binds an exact immutable definition/skill snapshot and advances through
 * ordered step templates. Run and step states are exhaustive with implicit
 * terminal immutability; every transition is atomic with its evidence.
 */
import { z } from 'zod';
import { idSchemas } from '@devguard/contracts';

export const WORKFLOW_RUN_SCHEMA_VERSION = 1 as const;

export const RUN_STATES = [
  'PENDING',
  'PROVISIONING',
  'RUNNING',
  'PAUSED',
  'WAITING_APPROVAL',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'RECONCILING',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const STEP_STATES = [
  'PENDING',
  'PROVISIONING',
  'RUNNING',
  'PAUSED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'RECONCILING',
] as const;
export type StepState = (typeof STEP_STATES)[number];

export const runSchema = z
  .object({
    id: z.string().min(1).max(128),
    workflowRunId: idSchemas.workflowRunId,
    repositoryId: z.string().min(1).max(128),
    definitionSnapshotId: z.string().min(1).max(128),
    state: z.enum(RUN_STATES),
    currentStepIndex: z.number().int().nonnegative(),
    steps: z
      .array(
        z.object({
          templateId: z.string().min(1).max(64),
          kind: z.string().min(1).max(32),
          state: z.enum(STEP_STATES),
          attempts: z.number().int().nonnegative(),
          terminalReason: z.string().max(64).optional(),
        }),
      )
      .max(64),
    idempotencyKey: z.string().min(1).max(128),
    createdAtIso: z.string().min(1).max(40),
    updatedAtIso: z.string().min(1).max(40),
  })
  .strict();
export interface WorkflowRun {
  readonly id: string;
  readonly workflowRunId: string;
  readonly repositoryId: string;
  readonly definitionSnapshotId: string;
  readonly state: RunState;
  readonly currentStepIndex: number;
  readonly steps: readonly WorkflowRunStep[];
  readonly idempotencyKey: string;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface WorkflowRunStep {
  readonly templateId: string;
  readonly kind: string;
  readonly state: StepState;
  readonly attempts: number;
  readonly terminalReason?: string | undefined;
}

export interface LaunchWorkflowInput {
  readonly workflowRunId: string;
  readonly repositoryId: string;
  readonly workflowDefinitionId: string;
  readonly definitionVersion: string;
  readonly idempotencyKey: string;
}

export const workflowRunContractsSchema = { runSchema };
