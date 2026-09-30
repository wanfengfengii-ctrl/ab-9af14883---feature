import { defineConfig } from 'vite';

// 构建为相对路径静态资源；开发态把 /api 代理到本机 API。
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_DEV_URL || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
