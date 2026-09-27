import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Behind CloudFront the SPA and the API share one origin (`/api/*` is routed
 * to the Lambda Function URL), so the app only ever calls relative
 * `/api/v1/...` paths. Locally the same relative paths are proxied to the API
 * dev server (`packages/server/src/local.ts`, port 8787), so there is no CORS
 * anywhere and no base URL to configure.
 */
const API_DEV_SERVER = process.env.FANTASY_API_URL ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_DEV_SERVER, changeOrigin: true }
    }
  },
  preview: {
    port: 4173
  }
});
