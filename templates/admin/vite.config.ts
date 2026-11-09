import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // This is a development proxy setting, not a browser-exposed VITE_* value.
  const env = loadEnv(mode, process.cwd(), 'API_PROXY_TARGET');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, './src') },
    },
    server: {
      port: 4201,
      proxy: {
        '/api': {
          target: env.API_PROXY_TARGET || 'http://localhost:4200',
          changeOrigin: true,
        },
      },
    },
  };
});
