import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts'),
        external: ['better-sqlite3', 'playwright', 'sharp'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
  },
});
