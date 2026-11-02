/**
 * 公司运营仪表盘上报脚本（scripts/company-report.mjs；new-forecast、Marketing 两个仓库内容相同）：
 * GitHub API 用替身；测 blocks 组成、【要你决定】筛选、main 最近一次 CI 和最近部署、读 GitHub 失败只坏一块、
 * 没有令牌跳过、429 等 60 秒重试一次、非 2xx 退出 1、--dry-run 只打印。
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error 脚本是 .mjs，没有类型
import { DEFAULT_INGEST_URL, buildReport, conclusionOf, main } from '../../../scripts/company-report.mjs';

const REPO = 'dollar3651314/new-forecast';
const SOURCE = 'new-forecast';
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 24 * 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// 本仓库成员开的、不是 fork 的 PR（批 2 加 external 以后要写明来源；测试数据补齐，原断言不变）
const OWN = { author_association: 'OWNER', head: { repo: { full_name: REPO } }, base: { repo: { full_name: REPO } } };
const PULLS = [
  { number: 7, title: '【要你决定】换首页文案', html_url: `https://github.com/${REPO}/pull/7`, created_at: iso(NOW - 3 * DAY - 3600_000), ...OWN },
  { number: 8, title: '修一个错别字', html_url: `https://github.com/${REPO}/pull/8`, created_at: iso(NOW - DAY), ...OWN },
  { number: 9, title: '加公司页【要你决定】', html_url: `https://github.com/${REPO}/pull/9`, created_at: iso(NOW - 3600_000), ...OWN },
];
const run = (id: number, sha: string, status: string, conclusion: string | null, at: number, extra: Record<string, unknown> = {}) => ({
  id, head_sha: sha.padEnd(40, '0'), head_branch: 'main', event: 'push', status, conclusion, html_url: `https://github.com/${REPO}/actions/runs/${id}`, run_started_at: iso(at), created_at: iso(at), updated_at: iso(at + 600_000), ...extra,
});
const RUNS = [
  run(105, 'eeeeeee', 'in_progress', null, NOW - 60_000),
  run(104, 'ddddddd', 'completed', 'success', NOW - 2 * 3600_000, { event: 'pull_request' }),
  run(103, 'ccccccc', 'completed', 'failure', NOW - 3 * 3600_000),
  run(102, 'bbbbbbb', 'completed', 'success', NOW - 4 * 3600_000),
  run(101, 'aaaaaaa', 'completed', 'success', NOW - 5 * 3600_000),
];
const JOBS: Record<number, unknown[]> = {
  102: [{ name: 'check', conclusion: 'success' }, { name: 'deploy', conclusion: 'skipped', completed_at: iso(NOW - 4 * 3600_000 + 300_000) }],
  101: [{ name: 'check', conclusion: 'success' }, { name: 'deploy', conclusion: 'success', completed_at: iso(NOW - 5 * 3600_000 + 420_000) }],
};

/** 替身：GitHub API + ingest；ingest 依次返回 answers 里的状态码 */
function fakeFetch({ pulls = PULLS, runs = RUNS, jobs = JOBS, fail = '' as string, answers = [200] as number[] } = {}) {
  const posts: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (init.method === 'POST') {
      posts.push({ url, init });
      const s = answers[Math.min(posts.length - 1, answers.length - 1)];
      return s === 200 ? ok({ ok: true, written: 2 }) : ok({ error: s === 429 ? 'too many requests' : '有块不对' }, s);
    }
    if (fail && u.pathname.includes(fail)) return ok({ message: 'Forbidden' }, 403);
    if (u.pathname === `/repos/${REPO}/pulls`) return ok(pulls);
    if (u.pathname === `/repos/${REPO}/actions/workflows/ci.yml/runs`) return ok({ total_count: runs.length, workflow_runs: runs });
    const m = u.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (m) return ok({ jobs: jobs[Number(m[1])] ?? [] });
    return ok({ message: 'Not Found' }, 404);
  });
  return { fn, posts };
}
const ENV = { COMPANY_SOURCE: SOURCE, GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'ghs_fake', COMPANY_INGEST_TOKEN: 'ci_only_company_ingest_token_0123456789' };
const quiet = () => ({ log: vi.fn(), error: vi.fn(), sleep: vi.fn(async () => {}) });

describe('组成 blocks', () => {
  it('prs 只留标题含【要你决定】的、算开了几天；ci 是 main 最近一次（不看 PR 的运行），部署是 deploy job 成功的那次', async () => {
    const { fn } = fakeFetch();
    const r = await buildReport({ env: ENV, fetch: fn, now: NOW });
    expect(r).toEqual({
      source: SOURCE,
      blocks: [
        { kind: 'prs', key: '', source_at: NOW, payload: { items: [
          // 批 2 新口径加了 tag（【要你决定】= decide）：研发同步更新这条逐字比对，测试会话已同意
          { number: 7, title: '【要你决定】换首页文案', url: `https://github.com/${REPO}/pull/7`, days: 3, tag: 'decide' },
          { number: 9, title: '加公司页【要你决定】', url: `https://github.com/${REPO}/pull/9`, days: 0, tag: 'decide' },
        ] } },
        { kind: 'ci', key: '', source_at: NOW, payload: {
          conclusion: 'running', url: `https://github.com/${REPO}/actions/runs/105`,
          sha: 'aaaaaaa'.padEnd(40, '0'), at: NOW - 5 * 3600_000 + 420_000,
          note: 'main 最近一次：eeeeeee · 2026-11-01 19:59',
        } },
      ],
    });
    // 带上 GITHUB_TOKEN 读本仓库
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/pulls?state=open&per_page=100&sort=created&direction=asc`);
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer ghs_fake' });
  });

  it('没有【要你决定】的 PR：items 为空；main 还没有 CI：conclusion = none，没有部署', async () => {
    const { fn } = fakeFetch({ pulls: [PULLS[1]], runs: [] });
    const r = await buildReport({ env: ENV, fetch: fn, now: NOW });
    expect(r.blocks[0].payload).toEqual({ items: [] });
    expect(r.blocks[1].payload).toEqual({ conclusion: 'none', note: 'main 还没有 CI 运行' });
  });

  it('找不到成功的部署：不写 sha、at，说明里写清楚', async () => {
    const { fn } = fakeFetch({ runs: [RUNS[2], RUNS[3]] });
    const r = await buildReport({ env: ENV, fetch: fn, now: NOW });
    expect(r.blocks[1].payload).toEqual({ conclusion: 'failure', url: `https://github.com/${REPO}/actions/runs/103`, note: 'main 最近一次：ccccccc · 2026-11-01 17:00；最近没找到成功的部署' });
  });

  it('读 GitHub 失败只坏那一块：status = error 写明原因，另一块照常', async () => {
    const { fn } = fakeFetch({ fail: '/actions/' });
    const r = await buildReport({ env: ENV, fetch: fn, now: NOW });
    expect(r.blocks[0].payload.items).toHaveLength(2);
    expect(r.blocks[1]).toEqual({ kind: 'ci', key: '', status: 'error', error: '读 GitHub 失败：GitHub /repos/' + REPO + '/actions/workflows/ci.yml/runs 返回 403', source_at: NOW });
  });

  it('GitHub 的结论换成仪表盘认的几种', () => {
    expect(conclusionOf(undefined)).toBe('none');
    expect(conclusionOf({ status: 'queued', conclusion: null })).toBe('running');
    expect(conclusionOf({ status: 'completed', conclusion: 'success' })).toBe('success');
    expect(conclusionOf({ status: 'completed', conclusion: 'cancelled' })).toBe('cancelled');
    expect(conclusionOf({ status: 'completed', conclusion: 'timed_out' })).toBe('failure');
    expect(conclusionOf({ status: 'completed', conclusion: 'startup_failure' })).toBe('failure');
  });
});

describe('上报', () => {
  it('没有 COMPANY_INGEST_TOKEN：打印"跳过"、退出 0、不读 GitHub 也不发', async () => {
    const { fn } = fakeFetch();
    const q = quiet();
    expect(await main({ argv: [], env: { ...ENV, COMPANY_INGEST_TOKEN: '' }, fetch: fn, now: NOW, ...q })).toBe(0);
    expect(q.log).toHaveBeenCalledWith('跳过：没有 COMPANY_INGEST_TOKEN');
    expect(fn).not.toHaveBeenCalled();
  });

  it('正常：POST 到正式版的 ingest，带令牌，body 就是 blocks', async () => {
    const { fn, posts } = fakeFetch();
    const q = quiet();
    expect(await main({ argv: [], env: ENV, fetch: fn, now: NOW, ...q })).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(DEFAULT_INGEST_URL);
    expect(posts[0].init.headers).toMatchObject({ authorization: `Bearer ${ENV.COMPANY_INGEST_TOKEN}` });
    const body = JSON.parse(String(posts[0].init.body));
    expect(body.source).toBe(SOURCE);
    expect(body.blocks.map((b: { kind: string }) => b.kind)).toEqual(['prs', 'ci']);
    expect(q.sleep).not.toHaveBeenCalled();
  });

  it('COMPANY_INGEST_URL 可以改地址（测试版）', async () => {
    const { fn, posts } = fakeFetch();
    await main({ argv: [], env: { ...ENV, COMPANY_INGEST_URL: 'https://marketing-staging.example.workers.dev/api/company/ingest' }, fetch: fn, now: NOW, ...quiet() });
    expect(posts[0].url).toBe('https://marketing-staging.example.workers.dev/api/company/ingest');
  });

  it('429：等 60 秒重试一次，成功就退出 0', async () => {
    const { fn, posts } = fakeFetch({ answers: [429, 200] });
    const q = quiet();
    expect(await main({ argv: [], env: ENV, fetch: fn, now: NOW, ...q })).toBe(0);
    expect(posts).toHaveLength(2);
    expect(q.sleep).toHaveBeenCalledTimes(1);
    expect(q.sleep).toHaveBeenCalledWith(60_000);
  });

  it('429 两次：只重试一次，退出 1 并打印响应', async () => {
    const { fn, posts } = fakeFetch({ answers: [429, 429] });
    const q = quiet();
    expect(await main({ argv: [], env: ENV, fetch: fn, now: NOW, ...q })).toBe(1);
    expect(posts).toHaveLength(2);
    expect(q.error).toHaveBeenCalledWith(expect.stringContaining('上报失败：429'));
  });

  it('其他非 2xx（例如 400）：不重试，退出 1 并打印响应', async () => {
    const { fn, posts } = fakeFetch({ answers: [400] });
    const q = quiet();
    expect(await main({ argv: [], env: ENV, fetch: fn, now: NOW, ...q })).toBe(1);
    expect(posts).toHaveLength(1);
    expect(q.error).toHaveBeenCalledWith(expect.stringContaining('有块不对'));
    expect(q.sleep).not.toHaveBeenCalled();
  });

  it('--dry-run：只打印 JSON，不发；没有令牌也能用', async () => {
    const { fn, posts } = fakeFetch();
    const q = quiet();
    expect(await main({ argv: ['--dry-run'], env: { ...ENV, COMPANY_INGEST_TOKEN: '' }, fetch: fn, now: NOW, ...q })).toBe(0);
    expect(posts).toHaveLength(0);
    expect(JSON.parse(q.log.mock.calls[0][0]).blocks).toHaveLength(2);
  });

  it('缺 COMPANY_SOURCE：退出 1', async () => {
    const q = quiet();
    expect(await main({ argv: [], env: { ...ENV, COMPANY_SOURCE: '' }, fetch: fakeFetch().fn, now: NOW, ...q })).toBe(1);
    expect(q.error).toHaveBeenCalledWith(expect.stringContaining('COMPANY_SOURCE'));
  });
});

// 批 2 新口径（Amos 2026-11-02："只有agents才是公司，其他都只是项目代码文件夹……其他项目内不保留这些资料也不认被其他人提交上来的东西。如果真有人提交了，只需要给我看就好"）
// 代码仓库的上报脚本完全不带正文：PR 只报 number、title、url、days、tag，外部人提交的再加 external: true。
// external 规则：author_association 不是 OWNER / MEMBER / COLLABORATOR，或 PR 来自 fork（head.repo.full_name ≠ base.repo.full_name，head.repo 为空也算）。
// 测试先写：脚本现在还带 body / questions，也没有 external，下面几条现在是红的。
describe('批 2 新口径：代码仓库只报 PR 标题，不带正文；外部提交标 external', () => {
  const LEAK = ['说明正文', '', '| # | 问题 | 建议 |', '|---|---|---|', '| 1 | 要不要换 Key AIzaSyD-FAKEfake0123456789abcdefghijklm？ | 建议换 |'].join('\n');
  const pull = (n: number, over: Record<string, unknown> = {}) => ({ number: n, title: `【要你决定】样例 ${n}`, html_url: `https://github.com/${REPO}/pull/${n}`, created_at: iso(NOW - DAY), body: LEAK, ...OWN, ...over });
  async function sent(pulls: unknown[]) {
    const { fn, posts } = fakeFetch({ pulls: pulls as typeof PULLS });
    const code = await main({ argv: [], env: ENV, fetch: fn, now: NOW, ...quiet() });
    return { code, text: posts.length ? String(posts[posts.length - 1].init.body) : '' };
  }
  const ALLOWED = ['days', 'external', 'number', 'tag', 'title', 'url'];

  it('PR 写了说明正文和问题表：发出去的 JSON 里没有 body、body_cut、questions，也没有正文里的任何文字', async () => {
    const { code, text } = await sent([pull(1), pull(2, { body: '长'.repeat(9000) })]);
    expect(code).toBe(0);
    const items = JSON.parse(text).blocks[0].payload.items as Record<string, unknown>[];
    expect(items.map((x) => x.number)).toEqual([1, 2]);
    for (const it of items) for (const k of Object.keys(it)) expect(ALLOWED, `#${it.number} 多了字段 ${k}`).toContain(k);
    expect(text).not.toMatch(/"body"|"body_cut"|"questions"/);
    for (const frag of ['说明正文', '要不要换 Key', 'AIzaSy', '长长长长']) expect(text, frag).not.toContain(frag);
  });

  it('本仓库成员开的 PR（OWNER / MEMBER / COLLABORATOR、不是 fork）：不带 external（或 external 不是 true）', async () => {
    const { text } = await sent([pull(1, { author_association: 'OWNER' }), pull(2, { author_association: 'MEMBER' }), pull(3, { author_association: 'COLLABORATOR' })]);
    for (const it of JSON.parse(text).blocks[0].payload.items as Record<string, unknown>[]) expect(it.external, `#${it.number}`).not.toBe(true);
  });

  it('外部人提交的 PR（CONTRIBUTOR、NONE、FIRST_TIME_CONTRIBUTOR、没写，或来自 fork）：带 external: true，只有标题、链接、开了几天', async () => {
    const { text } = await sent([
      pull(4, { author_association: 'CONTRIBUTOR' }), pull(5, { author_association: 'NONE' }), pull(6, { author_association: 'FIRST_TIME_CONTRIBUTOR' }), pull(7, { author_association: undefined }),
      pull(8, { head: { repo: { full_name: 'someone/fork' } } }), pull(9, { head: { repo: null } }),
    ]);
    const items = JSON.parse(text).blocks[0].payload.items as Record<string, unknown>[];
    expect(items.map((x) => x.number)).toEqual([4, 5, 6, 7, 8, 9]);
    for (const it of items) {
      expect(it.external, `#${it.number}`).toBe(true);
      expect(it).toMatchObject({ title: `【要你决定】样例 ${it.number}`, url: `https://github.com/${REPO}/pull/${it.number}`, days: 1 });
      for (const k of Object.keys(it)) expect(ALLOWED, `#${it.number} 多了字段 ${k}`).toContain(k);
    }
  });

  it('外部人提交的 PR 标题里没有【要你决定】也要报（只给 Amos 看一下）；自己人不带【要你决定】的照旧不报', async () => {
    const { text } = await sent([pull(10, { title: '改一下 README', author_association: 'NONE' }), pull(11, { title: '修一个错别字', author_association: 'OWNER' })]);
    const items = JSON.parse(text).blocks[0].payload.items as Record<string, unknown>[];
    expect(items.map((x) => x.number)).toEqual([10]);
    expect(items[0]).toMatchObject({ number: 10, title: '改一下 README', external: true });
    expect(items[0].body).toBeUndefined();
  });
});
