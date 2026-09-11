// Vitest config for @ostomy/api unit tests (ADR-0002). Integration tests
// against a real PostgreSQL instance (Testcontainers) land at P1.S5 and
// later, and will get their own config/`*.integration.spec.ts` naming so
// `pnpm test:unit` can keep excluding them.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `scripts/` too: the API client generator lives there and its
    // schema-rendering failure mode is silent (bad output still compiles),
    // so it needs coverage as much as anything under src/.
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts'],
    restoreMocks: true,
  },
});
