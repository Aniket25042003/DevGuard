import { defineWorkspace } from 'vitest/config';

/**
 * Vitest projects (C001/C096 conventions):
 * - `unit`: colocated package unit tests plus tests/integration suites that
 *   only need in-process fakes (no external services).
 * - `e2e`: gated cross-system suites under tests/e2e; never run implicitly by `pnpm test`.
 */
export default defineWorkspace([
  {
    extends: './vitest.shared.ts',
    test: {
      name: 'unit',
      include: ['packages/**/src/**/*.test.ts', 'tests/integration/src/**/*.test.ts'],
    },
  },
  {
    extends: './vitest.shared.ts',
    test: {
      name: 'e2e',
      include: ['tests/e2e/src/**/*.test.ts'],
      // E2E requires provisioned infrastructure (C098); keep sequential and explicit.
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 120_000,
    },
  },
]);
