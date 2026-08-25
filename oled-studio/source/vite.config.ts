import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // asterctl-web embeds this stable sibling directory at compile time.
    outDir: '../dist',
    emptyOutDir: true,
  },
});
