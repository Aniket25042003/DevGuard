/**
 * C042 §8/§10 — sandbox command execution contracts.
 *
 * One explicitly authorized command per run workspace under a mandatory
 * deadline and generation fence. Results always distinguish exit failure,
 * timeout, cancellation, block, and unknown; shell-string execution is denied
 * by default; output is bounded/normalized/redacted and never proves success
 * (ideals satisfied only by verified provider terminal state + exit code 0).
 */
import { z } from 'zod';
import { idSchemas } from '@devguard/contracts';

export const SANDBOX_COMMAND_SCHEMA_VERSION = 1 as const;

export const COMMAND_CLASSES = [
  'read',
  'build',
  'test',
  'scan',
  'install',
  'network',
  'destructive',
] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];

export const COMMAND_RESULT_STATUSES = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'blocked',
  'unknown',
] as const;
export type CommandResultStatus = (typeof COMMAND_RESULT_STATUSES)[number];

export const COMMAND_STATES = [
  'PROPOSED',
  'AUTHORIZED',
  'QUEUED',
  'STARTING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMING_OUT',
  'CANCELLING',
  'TERMINATING',
  'TIMED_OUT',
  'CANCELLED',
  'TERMINATION_FAILED',
  'UNKNOWN',
  'RECONCILING',
  'QUARANTINED',
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

export const DEFAULT_CEILINGS_MS: Readonly<Record<CommandClass, number>> = {
  read: 5 * 60_000,
  build: 10 * 60_000,
  test: 10 * 60_000,
  scan: 10 * 60_000,
  install: 10 * 60_000,
  network: 10 * 60_000,
  destructive: 10 * 60_000,
};

const workspaceFenceSchema = z
  .object({
    workspaceId: idSchemas.workflowRunId,
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    ready: z.literal(true),
  })
  .strict();

const envValueSchema = z.union([
  z.object({ kind: z.literal('secret_ref'), ref: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('literal_safe'), value: z.string().min(1).max(200) }),
]);
export type EnvValue =
  | { readonly kind: 'secret_ref'; readonly ref: string }
  | { readonly kind: 'literal_safe'; readonly value: string };

export const sandboxCommandSchema = z
  .object({
    commandId: z.string().min(1).max(128),
    workspace: workspaceFenceSchema,
    actionDecisionId: z.string().min(1).max(128),
    class: z.enum(COMMAND_CLASSES),
    executable: z
      .string()
      .min(1)
      .max(1024)
      .refine((v) => !v.includes('\u0000') && !v.includes('\n')),
    args: z.array(z.string().min(0).max(16_384)).max(4096),
    cwd: z
      .string()
      .min(1)
      .max(1024)
      .refine((v) => !v.startsWith('/')),
    env: z.array(z.tuple([z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), envValueSchema])).max(64),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(10 * 60_000),
    output: z
      .object({
        maxStdoutBytes: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024),
        maxStderrBytes: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024),
      })
      .strict(),
    generation: z.number().int().nonnegative(),
  })
  .strict();
export interface SandboxCommand {
  readonly commandId: string;
  readonly workspace: {
    readonly workspaceId: string;
    readonly headSha: string;
    readonly ready: true;
  };
  readonly actionDecisionId: string;
  readonly class: CommandClass;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: readonly [string, EnvValue][];
  readonly timeoutMs: number;
  readonly output: { readonly maxStdoutBytes: number; readonly maxStderrBytes: number };
  readonly generation: number;
}

export interface OutputRef {
  readonly outputId: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly checksum: string;
  readonly chunks: number;
}

export const sandboxResultSchema = z
  .object({
    status: z.enum(COMMAND_RESULT_STATUSES),
    exitCode: z.number().int().min(-1).max(255).nullable(),
    signal: z.string().max(32).nullable(),
    durationMs: z.number().int().nonnegative(),
    terminationReason: z.string().max(64),
    stdout: z
      .object({
        outputId: z.string(),
        bytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
        checksum: z.string(),
        chunks: z.number().int().nonnegative(),
      })
      .strict(),
    stderr: z
      .object({
        outputId: z.string(),
        bytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
        checksum: z.string(),
        chunks: z.number().int().nonnegative(),
      })
      .strict(),
    truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }).strict(),
    artifactIds: z.array(z.string()),
  })
  .strict();
export interface SandboxResult {
  readonly status: CommandResultStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly terminationReason: string;
  readonly stdout: OutputRef;
  readonly stderr: OutputRef;
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };
  readonly artifactIds: readonly string[];
}

export const sandboxCommandContractsSchema = { sandboxCommandSchema, sandboxResultSchema };
