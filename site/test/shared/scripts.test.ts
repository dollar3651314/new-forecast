/** 脚本：产物检查（拦住交易类路径和接口）、D1 一键准备的配置改写。 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 脚本是 .mjs，没有类型
import { check } from '../../scripts/check-dist.mjs';
// @ts-expect-error 脚本是 .mjs，没有类型
import { DB_NAMES, parseList, patchConfig } from '../../scripts/ensure-d1.mjs';

function fakeDist(files: Record<string, string>): string {
  const d = mkdtempSync(path.join(tmpdir(), 'qc-dist-'));
  const base: Record<string, string> = {
    'index.html':
      '<meta name="qc-site" content="prelaunch"><meta property="og:image" content="https://www.quickcome.online/og-return-rate.png"><script type="module" src="/assets/index-a.js"></script>',
    'admin.html': '<script type="module" src="/assets/admin-a.js"></script>',
    'assets/index-a.js': 'import{x}from"./Chrome-a.js";fetch("/api/public/subscribe");"/api/public/confirm";"/api/public/unsubscribe";"/api/public/invite";"/api/public/board";"/api/public/matches"',
    'assets/Chrome-a.js': 'export const x=1;"/api/public/site"',
    'assets/admin-a.js': 'fetch("/api/admin/login")',
    'og-return-rate.png': 'png',
    'robots.txt': '',
    'sitemap.xml': '',
    _headers: '',
    'favicon.svg': '',
    ...files,
  };
  for (const [f, s] of Object.entries(base)) {
    mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    writeFileSync(path.join(d, f), s);
  }
  return d;
}

describe('check-dist', () => {
  it('正常的产物通过（名单页接口只在 admin 的 JS 里）', () => {
    expect(check(fakeDist({}))).toEqual([]);
  });
  it.each([
    ['fetch("/api/auth/login")', '交易或账户类接口'],
    ['fetch("/api/wallet/deposit")', '交易或账户类接口'],
    ['href:"/register"', '交易或账户类页面的路径'],
    ['location="/deposit?x=1"', '交易或账户类页面的路径'],
    ['"/markets/123"', '交易或账户类页面的路径'],
    ['"https://x.y.workers.dev"', 'workers.dev'],
  ])('拦住 %s', (code, what) => {
    const problems = check(fakeDist({ 'assets/Chrome-a.js': `export const x=1;${code}` }));
    expect(problems.join('\n')).toContain(what);
  });
  it('公开页面引用到的 JS 里有 /api/admin：失败', () => {
    expect(check(fakeDist({ 'assets/Chrome-a.js': 'export const x="/api/admin/metrics"' })).join('\n')).toContain('公开页面的 JS 里有名单页接口');
  });
  it('缺分享卡片、缺接口：失败', () => {
    const p = check(fakeDist({ 'index.html': '<meta name="qc-site" content="prelaunch"><script type="module" src="/assets/admin-a.js"></script>' })).join('\n');
    expect(p).toContain('og:image');
    expect(p).toContain('/api/public/subscribe');
  });
});

describe('ensure-d1', () => {
  const toml = `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "new-forecast-site"\ndatabase_id = "local-only"\n\n[[env.staging.d1_databases]]\nbinding = "DB"\ndatabase_name = "new-forecast-site-staging"\ndatabase_id = "local-only"\n`;
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  it('只改对应环境的 database_id', () => {
    const out = patchConfig(toml, DB_NAMES.staging, uuid);
    expect(out).toContain(`database_name = "new-forecast-site-staging"\ndatabase_id = "${uuid}"`);
    expect(out).toContain('database_name = "new-forecast-site"\ndatabase_id = "local-only"');
  });
  it('编号格式不对、找不到配置时报错', () => {
    expect(() => patchConfig(toml, DB_NAMES.production, 'nope')).toThrow();
    expect(() => patchConfig('name = "x"', DB_NAMES.production, uuid)).toThrow();
  });
  it('wrangler d1 list --json 前面有提示行也能解析', () => {
    expect(parseList('提示\n[{"name":"a","uuid":"b"}]')).toEqual([{ name: 'a', uuid: 'b' }]);
  });
});
