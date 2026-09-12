// Vitest config for @ostomy/web (ADR-0002). jsdom, not node: every spec
// renders a component through @testing-library/react.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
    restoreMocks: true,
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
