/**
 * 副驾驶中转服务（copilot/src）：默认关着、令牌和来源、限流、打分（政治题目兜底）、写稿后的程序检查、每天上限、当天记录。
 * Gemini 用替身（不连外网）；D1 用 Miniflare 的本地 SQLite。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { checkDraft, xLength } from '../../copilot/src/checks';
import type { Env } from '../../copilot/src/env';
import { handle, twDay } from '../../copilot/src/index';
import { SITE_DIR, T0 } from '../worker/helpers';

const TOKEN = 'ci_only_copilot_token_0123456789';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: path.join(SITE_DIR, 'test/copilot/wrangler.test.toml'), persist: false, remoteBindings: false, envFiles: [] });
  db = proxy.env.DB;
  dispose = proxy.dispose;
  const sql = readFileSync(path.join(SITE_DIR, 'copilot/migrations/0001_init.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  await db.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
});
afterAll(async () => dispose());
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM events'), db.prepare('DELETE FROM rate')]);
});

const env = (over: Partial<Env> = {}): Env => ({ DB: db, ENVIRONMENT: 'test', COPILOT_TOKEN: TOKEN, GEMINI_API_KEY: 'ci_only_gemini_key', DAILY_REPLY_CAP: '2', ...over });
function req(method: string, p: string, body?: unknown, h: Record<string, string> = {}): Request {
  return new Request(`https://copilot.example.test${p}`, {
    method,
    headers: { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...h },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
/** Gemini 替身：按顺序返回给定的 JSON；记录收到的请求 */
function fakeGemini(...answers: unknown[]) {
  const calls: { url: string; body: { contents: { parts: { text: string }[] }[] }; key: string | null }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('x-goog-api-key') });
    const a = answers.shift();
    if (a instanceof Response) return a;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] } }] }), { status: 200 });
  };
  return { fetcher, calls };
}
const POST = { id: '1850000000000000001', author: '@hoops_demo', text: '明天早上勇士主場打湖人，誰會先爆發？', replies: 86, ageMinutes: 120 };

describe('默认关着、令牌和来源', () => {
  it('健康检查不要令牌，不返回密钥；没填令牌或 Gemini Key 时 /v1/* 一律 404', async () => {
    const h = await (await handle(new Request('https://c.test/health'), env(), T0)).json();
    expect(h).toMatchObject({ status: 'UP', copilot: 'ok' });
    expect(JSON.stringify(h)).not.toContain(TOKEN);
    for (const over of [{ COPILOT_TOKEN: undefined }, { COPILOT_TOKEN: 'short' }, { GEMINI_API_KEY: undefined }]) {
      expect((await handle(req('GET', '/v1/today'), env(over), T0)).status).toBe(404);
      expect(await (await handle(new Request('https://c.test/health'), env(over), T0)).json()).toMatchObject({ copilot: 'not_configured' });
    }
  });
  it('不是插件来源的请求 404；令牌不对 401；插件的预检请求放行', async () => {
    expect((await handle(req('GET', '/v1/today', undefined, { origin: 'https://evil.example' }), env(), T0)).status).toBe(404);
    expect((await handle(new Request('https://c.test/v1/today', { headers: { authorization: `Bearer ${TOKEN}` } }), env(), T0)).status).toBe(404);
    expect((await handle(req('GET', '/v1/today', undefined, { authorization: 'Bearer wrong' }), env(), T0)).status).toBe(401);
    const pre = await handle(new Request('https://c.test/v1/score', { method: 'OPTIONS', headers: { origin: ORIGIN } }), env(), T0);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    // 指定了插件 ID 时只接受那一个
    expect((await handle(req('GET', '/v1/today'), env({ ALLOWED_ORIGIN: 'chrome-extension://ppppppppppppppppppppppppppppppp' }), T0)).status).toBe(404);
  });
  it('全站每分钟最多 30 次', async () => {
    for (let i = 0; i < 30; i++) expect((await handle(req('GET', '/v1/today'), env(), T0)).status).toBe(200);
    expect((await handle(req('GET', '/v1/today'), env(), T0)).status).toBe(429);
    expect((await handle(req('GET', '/v1/today'), env(), T0 + 60_000)).status).toBe(200);
  });
});

describe('打分', () => {
  it('交给 Gemini 打分（Key 只在请求头里）；政治题目不送去、直接 0 分；Gemini 没给分的算 0 分；分数夹在 0～100', async () => {
    const g = fakeGemini({ items: [{ id: POST.id, score: 130, reasons: ['NBA 焦點戰', '留言多'] }] });
    const pol = { id: '1850000000000000002', author: '@p', text: '這次總統選舉你投誰？' };
    const miss = { id: '1850000000000000003', author: '@m', text: '今天天氣好' };
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST, pol, miss] }), env(), T0, g.fetcher);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      items: [
        { id: POST.id, score: 100, reasons: ['NBA 焦點戰', '留言多'] },
        { id: pol.id, score: 0, reasons: ['政治或排除的题目'] },
        { id: miss.id, score: 0, reasons: ['团队没有给出评分'] },
      ],
    });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0].key).toBe('ci_only_gemini_key');
    expect(g.calls[0].url).not.toContain('ci_only_gemini_key');
    const sent = g.calls[0].body.contents[0].parts[0].text;
    expect(sent).toContain(POST.text);
    expect(sent).not.toContain('總統');
  });
  it('请求不对 400；Gemini 出错 502（插件显示"团队暂时没回应"）', async () => {
    expect((await handle(req('POST', '/v1/score', { product: 'nope', platform: 'x', posts: [POST] }), env(), T0)).status).toBe(400);
    expect((await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'ig', posts: [POST] }), env(), T0)).status).toBe(400);
    expect((await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [{ id: 'a b', text: 'x' }] }), env(), T0)).status).toBe(400);
    const g = fakeGemini(new Response('quota', { status: 429 }));
    expect((await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, g.fetcher)).status).toBe(502);
  });
});

describe('写稿和程序检查', () => {
  it('只给通过检查的草稿：不能说的话、提产品、有链接、有数字没出处的都拿掉；记一条 drafted', async () => {
    const g = fakeGemini({
      drafts: [
        { tone: '补资讯', text: '台灣時間 10/31 早上 10:00 開打，勇士主場。', source: 'nba.com 賽程' },
        { tone: '丢问题', text: '你覺得 Curry 會先熱手嗎？' },
        { tone: '坏', text: '來 Quick Come 預測穩賺！' },
        { tone: '坏2', text: '看這裡 https://example.com' },
      ],
    });
    const r = await handle(req('POST', '/v1/draft', { product: 'forecast', platform: 'x', post: POST }), env(), T0, g.fetcher);
    const out = (await r.json()) as { drafts: { text: string }[]; dropped: number };
    expect(out.drafts.map((d) => d.text)).toEqual(['台灣時間 10/31 早上 10:00 開打，勇士主場。', '你覺得 Curry 會先熱手嗎？']);
    // 最多看前 3 条：第 3 条被拿掉，第 4 条不看
    expect(out.dropped).toBe(1);
    const noSrc = fakeGemini({ drafts: [{ tone: 'x', text: '勇士上季主場勝率 70%', source: '' }] });
    expect(((await (await handle(req('POST', '/v1/draft', { product: 'forecast', platform: 'x', post: POST }), env(), T0, noSrc.fetcher)).json()) as { drafts: unknown[] }).drafts).toEqual([]);
    const ev = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'drafted'").first<{ n: number }>();
    expect(ev!.n).toBe(2);
  });
  it('政治题目不写稿、不调用 Gemini', async () => {
    const g = fakeGemini();
    const r = await handle(req('POST', '/v1/draft', { product: 'forecast', platform: 'threads', post: { ...POST, text: '罷免案你怎麼看' } }), env(), T0, g.fetcher);
    expect(await r.json()).toMatchObject({ drafts: [] });
    expect(g.calls).toHaveLength(0);
  });
  it('程序检查：X 中文算 2 个字；Threads 500 字', () => {
    expect(xLength('abc')).toBe(3);
    expect(xLength('中文')).toBe(4);
    expect(checkDraft('中'.repeat(141), 'x')).toContain('太长');
    expect(checkDraft('中'.repeat(140), 'x')).toEqual([]);
    expect(checkDraft('中'.repeat(140), 'threads')).toEqual([]);
    expect(checkDraft('别错过这场', 'threads')).toContain('不能说的话：别错过');
    expect(checkDraft('去 quickcome 看看', 'x')).toContain('提到了产品');
    expect(checkDraft('www.abc.tw', 'x')).toContain('有链接');
  });
});

describe('记录、每天上限和当天汇总', () => {
  it('同意超过每天上限 429；跳过不算；当天汇总按台湾日期；30 天前的记录删掉', async () => {
    await db.prepare("INSERT INTO events (at, day, product, platform, post_id, action) VALUES (?1, '2026-09-01', 'forecast', 'x', 'old', 'approve')").bind(T0 - 31 * 24 * 3600_000).run();
    const log = (action: string, id: string) => handle(req('POST', '/v1/log', { product: 'forecast', platform: 'x', postId: id, author: '@a', score: 80, action, draft: '回覆' }), env(), T0);
    expect((await log('approve', 'p1')).status).toBe(200);
    expect((await log('skip', 'p2')).status).toBe(200);
    expect((await log('approve', 'p3')).status).toBe(200);
    expect((await log('approve', 'p4')).status).toBe(429);
    expect((await log('delete', 'p5')).status).toBe(400);
    const t = (await (await handle(req('GET', '/v1/today'), env(), T0)).json()) as { day: string; cap: number; approved: number; skipped: number; items: unknown[] };
    expect(t).toMatchObject({ day: twDay(T0), cap: 2, approved: 2, skipped: 1 });
    expect(t.day).toBe('2026-10-29');
    expect((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE post_id = 'old'").first<{ n: number }>())!.n).toBe(0);
  });
});
