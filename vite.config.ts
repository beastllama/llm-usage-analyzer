import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// No API keys are used anywhere in the browser bundle.
// The dev and preview servers listen on localhost only. Pass --host to expose them on purpose.
export default defineConfig({
  // Base path for hosting. Local dev, the CLI and Vercel use '/'. Set VITE_BASE to host under a sub-path.
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    host: 'localhost',
  },
  preview: {
    port: 4173,
    host: 'localhost',
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
