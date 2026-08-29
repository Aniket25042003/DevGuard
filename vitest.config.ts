import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * DevGuard Vitest configuration (C001/C096 conventions).
 *
 * Tests execute against BUILT package output: root scripts run
 * `tsc -b tsconfig.json` before every suite so tests, typecheck, and shipped
 * declarations can never drift apart. The web project is the exception: Next
 * owns `apps/web` typecheck (`next build` / `tsc --noEmit`) so component tests
 * compile TSX via Vitest/esbuild.
 *
 * Projects:
 * - `unit`: package + tests/integration suites (runs via `pnpm test`)
 * - `web`:  apps/web component + client tests (jsdom)
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
            'apps/cli/src/**/*.test.ts',
            'tests/integration/src/**/*.test.ts',
          ],
        },
      },
      {
        resolve: {
          alias: {
            '@': path.join(repoRoot, 'apps/web'),
          },
        },
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/**/*.test.ts', 'apps/web/**/*.test.tsx'],
          setupFiles: ['apps/web/vitest.setup.ts'],
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
