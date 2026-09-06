// Vitest config for @ostomy/core (ADR-0002). Coverage is scoped to
// src/validation, not the whole package: docs/testing.md sets no global
// percentage gate, but does require validation rules covered at full
// branch coverage. Run `pnpm --filter @ostomy/core test:coverage` to see
// it enforced.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/validation/**/*.ts'],
      exclude: [
        'src/validation/**/*.spec.ts',
        'src/validation/**/*.type-test.ts',
        'src/validation/types.ts',
        'src/validation/thresholds.ts',
        'src/validation/index.ts',
      ],
      thresholds: {
        branches: 100,
        statements: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
