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
    // Emit .map files but omit the sourceMappingURL comment so browsers never
    // load them. CI can archive maps for crash symbolication without shipping
    // unminified TS source (and internal API/token field names) to every
    // visitor. See docs/REVIEW/frontend.md FE-01.
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('livekit-client')) return 'vendor-livekit';
          if (id.includes('@radix-ui')) return 'vendor-radix';
          if (id.includes('@tanstack')) return 'vendor-tanstack';
          if (id.includes('highlight.js') || id.includes('lowlight')) return 'vendor-markdown';
          if (id.includes('lucide-react')) return 'vendor-icons';
          if (id.includes('react') || id.includes('react-dom')) return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
});
