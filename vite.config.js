import { defineConfig } from 'vite';

// Render serves the site at the root of its address (icebuddy.onrender.com). Set BASE_PATH to host it under a subfolder.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
