/**
 * 页面构建（Vite + React）：两个入口——index.html（公开页面）和 admin.html（名单页，地址 /admin）；产物 site/dist，给 Worker 的静态资源用。
 * 构建后用 scripts/check-dist.mjs 检查产物里没有交易类的路径和接口、公开页面的代码里没有名单页接口。
 * 本机开发：先 npm run build，再 npm run dev（wrangler dev 一起提供页面和接口）。
 */
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'web'),
  publicDir: resolve(__dirname, 'web/public'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'web/index.html'), admin: resolve(__dirname, 'web/admin.html') },
    },
  },
});
