import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * DevGuard root ESLint (flat) config.
 *
 * Invariants enforced here (C001):
 * - No broad `any` in production sources.
 * - Unused variables fail.
 * - `console` is forbidden except in tooling scripts and app bootstrap entrypoints,
 *   where structured logging is not yet available (C061 introduces the logger).
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/*.d.ts',
      'docs/implementation-plan/**',
      // Negative fixtures intentionally contain type errors and banned patterns.
      'tooling/fixtures/negative/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Buffer: 'readonly',
        crypto: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortSignal: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // Tooling scripts run in plain Node before any logger exists.
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs', 'tooling/**/*.mjs', 'tooling/**/*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // App bootstrap entrypoints log startup diagnostics until C061 lands.
    files: ['apps/*/src/main.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Test sources may use console sparingly but still no `any`.
    files: ['**/*.test.ts', 'tests/**/*.ts', 'tooling/fixtures/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
