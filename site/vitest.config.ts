/**
 * 测试（vitest）分三组：
 * - worker：Node 里跑 Worker 的代码，D1 用 wrangler getPlatformProxy 给的本地实现（底下是 Miniflare 的真实 SQLite，和线上 D1 同一套 SQL），
 *   每个测试文件一个新库并执行 migrations/ 的全部迁移；外部服务（Resend、OKX、币安）全部用替身（C54）；时间用固定的"现在"（C106）。
 * - web：jsdom 里跑页面组件、三语文案。
 * - shared：前后端共用的规则（C108）和脚本。
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Worker 的结构化日志（{"event":…}）不打印到测试输出
    onConsoleLog: (log) => !log.startsWith('{"event"'),
    projects: [
      { extends: true, test: { name: 'worker', environment: 'node', include: ['test/worker/**/*.test.ts'] } },
      { extends: true, test: { name: 'shared', environment: 'node', include: ['test/shared/**/*.test.ts'] } },
      { extends: true, test: { name: 'web', environment: 'jsdom', include: ['test/web/**/*.test.tsx', 'test/web/**/*.test.ts'], setupFiles: ['test/web/setup.ts'], globals: true } },
    ],
  },
});
