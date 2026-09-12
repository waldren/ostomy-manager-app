// Vite config for the patient web SPA (SRS_v2 §4.2). Online-only — no PWA
// plugin, no service-worker cache; see the app README for why.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
