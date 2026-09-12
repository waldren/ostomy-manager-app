// Vitest config for @ostomy/ui (ADR-0002). jsdom, not node: every spec in
// this package renders a component through @testing-library/react.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // `@testing-library/react`'s automatic afterEach(cleanup) registration
    // only fires when it finds a global `afterEach` — without `globals:
    // true` here, DOM trees from earlier tests in the same file accumulate
    // and `getByRole` queries start matching more than one element.
    globals: true,
    include: ['src/**/*.spec.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
    restoreMocks: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
