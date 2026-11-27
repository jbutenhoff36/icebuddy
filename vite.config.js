import { defineConfig } from 'vite';

// GitHub Pages serves the site at https://jbutenhoff36.github.io/icebuddy/, so every path is under /icebuddy/.
export default defineConfig({
  base: process.env.BASE_PATH || '/icebuddy/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
