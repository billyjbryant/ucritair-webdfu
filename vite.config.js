import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react({
      include: '**/*.jsx',
      exclude: '**/*.js',
    }),
  ],
  server: {
    port: 3000,
    strictPort: true,
    open: true,
  },
  build: {
    outDir: './dist', // Adjust output directory relative to the root
    sourcemap: true,
  },
  publicDir: './public', // Adjust public directory relative to the root
  assetsInclude: ['**/*.bin'],
});
