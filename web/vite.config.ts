import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // stick PC runs Chrome 72 (2018): transpile optional chaining / nullish
    // coalescing etc. down; Chrome 61 covers native ESM + async/await.
    target: 'chrome61',
  },
});
