/**
 * 页面构建（Vite + React）：两个入口——index.html（公开页面）和 console.html（名单页；只由 Worker 在密钥 ADMIN_PATH 的地址下提供，直接访问 /console.html 和别的不存在的地址一样）；产物 site/dist，给 Worker 的静态资源用。
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
    // 名单页的 Excel 库（SheetJS）约 500 KB，只在点导出 / 导入时才加载（动态 import），不影响首屏
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: { index: resolve(__dirname, 'web/index.html'), console: resolve(__dirname, 'web/console.html') },
    },
  },
});
