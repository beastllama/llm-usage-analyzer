import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// No API keys are built into the browser bundle. The optional AI tip uses a key the user pastes in.
// The dev and preview servers listen on localhost only. Pass --host to expose them on purpose.
export default defineConfig({
  // Base path for hosting. Local dev and the CLI use '/'. The GitHub Pages workflow sets VITE_BASE.
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
