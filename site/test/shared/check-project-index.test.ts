/**
 * 项目地图和索引检查 scripts/check-project-index.mjs 的"禁放文件"（agents C147；v0.35 修改建议第六节）。
 * 在临时目录建一个最小的 git 仓库，真的跑一遍脚本看退出码和提示。本文件和另一个代码仓库里的同名测试内容一致，只有脚本路径不同。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../../scripts/check-project-index.mjs');

function fakeRepo(files: Record<string, string>, cfg: Record<string, unknown> = {}): string {
  const d = mkdtempSync(path.join(tmpdir(), 'check-index-'));
  execFileSync('git', ['init', '-q'], { cwd: d });
  const base: Record<string, string> = {
    'CLAUDE.md': '先读 项目地图.md',
    'AGENTS.md': '先读 项目地图.md',
    '项目地图.md': '细节见 项目索引.md',
    '项目索引.md': '# 项目索引',
    '项目索引.config.json': JSON.stringify({ map: '项目地图.md', index: '项目索引.md', ...cfg }),
    ...files,
  };
  for (const [f, s] of Object.entries(base)) {
    mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    writeFileSync(path.join(d, f), s);
  }
  return d;
}

function run(dir: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('check-project-index ⑥ 禁放文件（agents C147：公司资料只放 agents）', () => {
  it('只有代码和地图、索引时通过', () => {
    const r = run(fakeRepo({ 'src/index.ts': 'export {}' }));
    expect(r.out).toContain('项目索引检查通过');
    expect(r.code).toBe(0);
  });

  it.each([
    ['Amos待办.md', 'Amos待办'],
    ['docs/待办.md', '待办'],
    ['开发计划.md', '计划'],
    ['进度.md', '进度'],
    ['交接记录.md', '交接记录'],
    ['状态卡.md', '状态卡'],
    ['开发记录.md', '开发记录'],
    ['决定记录.md', '决定记录'],
    ['需求文档/v1.md', '需求文档/'],
    ['docs/市场/草稿.md', '市场/'],
    ['交付记录/v1.md', '交付记录/'],
    ['测试报告/v1.md', '测试报告/'],
  ])('%s 命中"%s"就报错', (file, name) => {
    const r = run(fakeRepo({ [file]: '公司资料' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('禁放文件');
    expect(r.out).toContain(file);
    expect(r.out).toContain(`"${name}"`);
  });

  it('还没提交的新文件也查', () => {
    const d = fakeRepo({});
    writeFileSync(path.join(d, '进度.md'), 'x');
    expect(run(d).code).toBe(1);
  });

  it('文件夹类的名字只按整段文件夹算：市场.md、超市场/ 不算命中"市场/"', () => {
    const r = run(fakeRepo({ '市场.md': 'x', 'src/超市场/a.ts': 'x' }));
    expect(r.out).not.toContain('禁放文件');
    expect(r.code).toBe(0);
  });

  it('配置 forbidden.allow 写了的放行（支持 * 和 **），没写的照样报', () => {
    const r = run(fakeRepo({ 'src/计划.ts': 'x', 'fixtures/进度/a.json': '{}', '进度.md': 'x' }, { forbidden: { allow: ['src/计划.ts', 'fixtures/**'] } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('进度.md');
    expect(r.out).not.toContain('src/计划.ts');
    expect(r.out).not.toContain('fixtures/进度/a.json');
  });

  it('被 .gitignore 忽略的文件不查', () => {
    const r = run(fakeRepo({ '.gitignore': '本机/\n', '本机/进度.md': 'x' }));
    expect(r.code).toBe(0);
  });
});
