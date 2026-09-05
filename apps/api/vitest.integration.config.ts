// Vitest config for @ostomy/api integration tests (ADR-0002): real
// PostgreSQL via Testcontainers, never a mocked Prisma client — see
// docs/testing.md "Runners" for why. Kept as a separate config file rather
// than a second `include` glob on vitest.config.ts so `pnpm test:unit` and
// `pnpm test:integration` are two genuinely independent invocations (a
// missing Docker daemon must never affect the unit run) rather than one
// config with a flag that has to be threaded through correctly every time.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.spec.ts'],
    exclude: ['**/node_modules/**'],
    // Spinning up a Postgres container and running real migrations against
    // it is legitimately slower than the default 5s unit-test timeout.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
