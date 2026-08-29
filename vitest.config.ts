import { defineConfig } from 'vitest/config';

/**
 * DevGuard Vitest configuration (C001/C096 conventions).
 *
 * Tests execute against BUILT package output: root scripts run
 * `tsc -b tsconfig.json` before every suite so tests, typecheck, and shipped
 * declarations can never drift apart. No source-aliasing tricks.
 *
 * Projects:
 * - `unit`: package + tests/integration suites (runs via `pnpm test`)
 * - `e2e`:  gated suites under tests/e2e (`pnpm test:e2e`, sequential)
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    restoreMocks: true,
    reporters: ['default'],
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/api/src/**/*.test.ts',
            'apps/worker/src/**/*.test.ts',
            'tests/integration/src/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/src/**/*.test.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 120_000,
        },
      },
    ],
  },
});
