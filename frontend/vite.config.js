import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies both the REST API and the Socket.IO upgrade to the
 * backend, so the app is written against same-origin paths and needs no CORS
 * handling or environment-specific base URLs in the client code.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/queue': { target: 'http://127.0.0.1:4000', ws: true, changeOrigin: true },
      '/socket.io': { target: 'http://127.0.0.1:4000', ws: true, changeOrigin: true },
    },
  },
});
