import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port can be overridden with WEB_PORT — defaults to 3030 to avoid the very
// common port-3000 collision with other dev tools (Grafana, CRA, lots of
// scaffolds, plus apparently "tenacitos").
const port = Number(process.env['WEB_PORT'] ?? 3030);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/gateway': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
