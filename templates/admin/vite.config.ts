import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // 直接从源码处理 fe-form，避免 dist 中 external 引用解析失败
      '@zucker/fe-form': path.resolve(
        import.meta.dirname,
        '../../packages/fe-form/src/index.ts',
      ),
    },
  },
  server: {
    port: 4201,
    proxy: {
      '/api': {
        target: 'http://localhost:4200',
        changeOrigin: true,
      },
    },
  },
});
