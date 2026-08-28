/**
 * C042 §12/§17/§20 — command canonicalization, argv safety, and idempotency.
 *
 * Commands are canonicalized WITHOUT shell interpolation (executable+argv).
 * Shell-string execution is denied by default; NUL/newline/absolute-cwd and
 * unsafe env names are rejected. The canonical digest binds the operation key.
 */
import { createHash } from 'node:crypto';
import type { SandboxCommand } from './contracts.js';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalDigest(command: SandboxCommand): string {
  return sha256Hex(
    JSON.stringify({
      workspaceId: command.workspace.workspaceId,
      headSha: command.workspace.headSha,
      class: command.class,
      executable: command.executable,
      args: command.args,
      cwd: command.cwd,
      env: command.env,
        output: command.output,
      timeoutMs: command.timeoutMs,
      generation: command.generation,
    }),
  );
}

export function assertSafeArgv(command: SandboxCommand): void {
  if (command.executable.includes('\u0000') || command.args.some((a) => a.includes('\u0000'))) {
    throw new Error('SANDBOX_ARGV_NUL_DENIED');
  }
  if (/^(?:[A-Za-z]:[\\/]|[\\\\/])/.test(command.cwd) || command.cwd.startsWith('/') || command.cwd.includes('\u0000') || command.cwd.split(/[\\/]/).includes('..')) {
    throw new Error('SANDBOX_CWD_DENIED');
  }
  for (const [name] of command.env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('SANDBOX_ENV_NAME_DENIED');
  }
}

/** Idempotency key: command id + generation (C042 §20). */
export function commandIdempotencyKey(commandId: string, generation: number): string {
  return `command:${commandId}:generation:${generation}`;
}
