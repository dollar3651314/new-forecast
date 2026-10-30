/**
 * 副驾驶中转服务（copilot/src）：默认关着、令牌和来源、限流、打分（政治题目兜底）、写稿后的程序检查、每天上限、当天记录。
 * Gemini 用替身（不连外网）；D1 用 Miniflare 的本地 SQLite。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { checkDraft, xLength } from '../../copilot/src/checks';
import type { Env } from '../../copilot/src/env';
import { handle, twDay } from '../../copilot/src/index';
import { extractJson, RESERVE } from '../../copilot/src/workers-ai';
import { SITE_DIR, T0 } from '../worker/helpers';

const TOKEN = 'ci_only_copilot_token_0123456789';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: path.join(SITE_DIR, 'test/copilot/wrangler.test.toml'), persist: false, remoteBindings: false, envFiles: [] });
  db = proxy.env.DB;
  dispose = proxy.dispose;
  const sql = readdirSync(path.join(SITE_DIR, 'copilot/migrations')).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(path.join(SITE_DIR, 'copilot/migrations', f), 'utf8').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')).join(';\n');
  await db.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
});
afterAll(async () => dispose());
beforeEach(async () => {
  await db.batch(['events', 'rate', 'queue', 'auth_fail', 'auth_lock', 'ai_usage', 'model_usage', 'settings'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

const PASS = 'ci_only_copilot_password_01';
const env = (over: Partial<Env> = {}): Env => ({ DB: db, ENVIRONMENT: 'test', COPILOT_TOKEN: TOKEN, GEMINI_API_KEY: 'ci_only_gemini_key', COPILOT_PASSWORD: PASS, DAILY_REPLY_CAP: '2', ...over });
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
  it('全站每分钟最多 60 次（两个窗口一起跑）', async () => {
    for (let i = 0; i < 60; i++) expect((await handle(req('GET', '/v1/today'), env(), T0)).status).toBe(200);
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
      engine: 'gemini',
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
    // 5xx 换下一个模型；三个都 5xx 才报错
    const bad = fakeGemini(...[1, 2, 3].map(() => new Response('oops', { status: 500 })));
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, bad.fetcher);
    expect(r.status).toBe(502);
    // 原因给插件显示，不含 Key
    const j = (await r.json()) as { detail: string };
    expect(j.detail).toContain('gemini-flash-latest Google 那边出错（500）');
    expect(JSON.stringify(j)).not.toContain('ci_only_gemini_key');
  });
  it('思考强度设成 low；模型不认这个设置（400）就去掉再试一次', async () => {
    const ok = { candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{ id: POST.id, score: 65, reasons: [] }] }) }] } }] };
    const g = fakeGemini(new Response('bad field', { status: 400 }), new Response(JSON.stringify(ok), { status: 200 }));
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, g.fetcher);
    expect(await r.json()).toEqual({ items: [{ id: POST.id, score: 65, reasons: [] }], engine: 'gemini' });
    const cfgs = g.calls.map((c) => (c.body as unknown as { generationConfig: Record<string, unknown> }).generationConfig);
    expect(cfgs[0]).toMatchObject({ thinkingConfig: { thinkingLevel: 'low' } });
    expect(cfgs[1].thinkingConfig).toBeUndefined();
  });
  it('Gemini 超额（429）返回 503 + 30 秒后再试（2026-10-29 测试版：滚动几条就报错）', async () => {
    // 免费额度按模型算：第一个超额就换下一个
    const ok = { candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{ id: POST.id, score: 61, reasons: [] }] }) }] } }] };
    const g1 = fakeGemini(new Response('quota', { status: 429 }), new Response(JSON.stringify(ok), { status: 200 }));
    expect(((await (await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, g1.fetcher)).json()) as { items: { score: number }[] }).items[0].score).toBe(61);
    // 全都超额才算忙
    const g = fakeGemini(...[1, 2, 3].map(() => new Response('quota', { status: 429 })));
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, g.fetcher);
    expect(r.status).toBe(503);
    // 503 带每个模型的原因（2026-10-30 Amos：不要只说"团队忙"）
    expect(await r.json()).toEqual({
      error: 'team busy',
      retryAfter: 30,
      detail: 'gemini-3.6-flash 免费额度用完（429）；gemini-3.8-flash 免费额度用完（429）；gemini-flash-latest 免费额度用完（429）',
    });
  });
  it('某个模型超时或 5xx 就换下一个；诊断接口报每个模型的状态（不含 Key）', async () => {
    const ok = { candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [{ id: POST.id, score: 66, reasons: [] }] }) }] } }] };
    let n = 0;
    const fetcher = async (url: string) => {
      n += 1;
      if (url.includes('gemini-3.8-flash')) { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }
      if (url.includes('gemini-3.6-flash')) return new Response('down', { status: 503 });
      return new Response(JSON.stringify(ok), { status: 200 });
    };
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, fetcher);
    expect(((await r.json()) as { items: { score: number }[] }).items[0].score).toBe(66);
    expect(n).toBe(3);
    const d = await handle(req('GET', '/v1/diag'), env(), T0, async (url: string) => (url.includes('3.8') ? new Response('{"error":"key AIzaSyFAKE123 bad"}', { status: 403 }) : new Response(JSON.stringify(ok), { status: 200 })));
    const models = ((await d.json()) as { models: { model: string; ok: boolean; detail: string }[] }).models;
    expect(models.map((m) => [m.model, m.ok])).toEqual([['gemini-3.6-flash', true], ['gemini-3.8-flash', false], ['gemini-flash-latest', true], ['备用 AI（Workers AI）', false]]);
    expect(models[1].detail).toContain('HTTP 403');
    expect(models[1].detail).not.toContain('AIzaSyFAKE123');
  });
  it('模型名不存在（404）就换下一个；全都 404 才算出错；回答被 ```json 包住也能读', async () => {
    const ok = { candidates: [{ content: { parts: [{ text: '```json\n{"items":[{"id":"' + POST.id + '","score":70,"reasons":["NBA"]}]}\n```' }] } }] };
    const g = fakeGemini(new Response('no', { status: 404 }), new Response(JSON.stringify(ok), { status: 200 }));
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, g.fetcher);
    expect(await r.json()).toEqual({ items: [{ id: POST.id, score: 70, reasons: ['NBA'] }], engine: 'gemini' });
    expect(g.calls.map((c) => c.url.split('/models/')[1].split(':')[0])).toEqual(['gemini-3.6-flash', 'gemini-3.8-flash']);
    const all404 = fakeGemini(...[1, 2, 3].map(() => new Response('no', { status: 404 })));
    const r2 = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, all404.fetcher);
    expect(r2.status).toBe(502);
    expect(((await r2.json()) as { detail: string }).detail).toContain('gemini-flash-latest 这个 Key 用不了（404）');
  });
});

describe('备用 AI（Workers AI，2026-10-30 Amos 选 A）', () => {
  const quota = () => [1, 2, 3].map(() => new Response('quota', { status: 429 }));
  /** Workers AI 替身：按顺序返回给定的结果（Error 就抛出）；记录收到的请求 */
  function fakeAi(...answers: unknown[]) {
    const calls: { model: string; input: { messages: { role: string; content: string }[] } }[] = [];
    return {
      calls,
      AI: {
        run: async (model: string, input: unknown) => {
          calls.push({ model, input: input as (typeof calls)[number]['input'] });
          const a = answers.shift();
          if (a instanceof Error) throw a;
          return a;
        },
      },
    };
  }
  const used = async () => (await db.prepare('SELECT neurons FROM ai_usage').first<{ neurons: number }>())?.neurons ?? 0;

  it('Gemini 都超额时换备用 AI：去掉思考、标出 engine、按 token 记账', async () => {
    const ai = fakeAi({ response: '<think>想一想</think>\n{"items":[{"id":"' + POST.id + '","score":66,"reasons":["NBA"]}]}', usage: { prompt_tokens: 1000, completion_tokens: 200 } });
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env({ AI: ai.AI }), T0, fakeGemini(...quota()).fetcher);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [{ id: POST.id, score: 66, reasons: ['NBA'] }], engine: 'workers-ai' });
    expect(ai.calls[0].model).toBe('@cf/qwen/qwen3-30b-a3b-fp8');
    expect(ai.calls[0].input.messages[1].content).toMatch(/\/no_think$/);
    expect(await used()).toBeCloseTo((1000 * 4625 + 200 * 30475) / 1e6, 5);
  });
  it('Gemini 正常时不动备用 AI；新格式（choices）和对象形式的回答也能读', async () => {
    const ai = fakeAi();
    const ok = { items: [{ id: POST.id, score: 70, reasons: ['NBA'] }] };
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env({ AI: ai.AI }), T0, fakeGemini(ok).fetcher);
    expect(await r.json()).toEqual({ ...ok, engine: 'gemini' });
    expect(ai.calls).toHaveLength(0);
    expect(extractJson('说明文字 {"a":1} 结尾')).toEqual({ a: 1 });
    // 少一个 ]、回答被截断、多出右括号（2026-10-30 测试版"回答不是 JSON"）
    expect(extractJson('{"items":[{"id":"DfF5","score":0,"reasons":["無討論空間，僅個人投資經驗分享"}]}')).toEqual({ items: [{ id: 'DfF5', score: 0, reasons: ['無討論空間，僅個人投資經驗分享'] }] });
    expect(extractJson('{"items":[{"id":"a","score":70,"reasons":["NBA 焦點}戰"')).toEqual({ items: [{ id: 'a', score: 70, reasons: ['NBA 焦點}戰'] }] });
    expect(extractJson('{"a":[1,2]}]}')).toEqual({ a: [1, 2] });
    const ai2 = fakeAi({ choices: [{ message: { content: { items: [] } } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const r2 = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env({ AI: ai2.AI }), T0, fakeGemini(...quota()).fetcher);
    expect(r2.status).toBe(200);
  });
  it('今天的额度快到上限就不再调用，返回 503 稍后再试（不超出免费额度）', async () => {
    await db.prepare('INSERT INTO ai_usage (day, neurons) VALUES (?1, ?2)').bind(new Date(T0).toISOString().slice(0, 10), 8000 - RESERVE + 1).run();
    const ai = fakeAi();
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env({ AI: ai.AI }), T0, fakeGemini(...quota()).fetcher);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { detail: string }).detail).toMatch(/免费额度用完（429）；Workers AI 今天用到 8000 上限（台湾早上 8 点重置）$/);
    expect(ai.calls).toHaveLength(0);
    // 第二天（UTC）重新算
    const ai2 = fakeAi({ response: '{"items":[]}', usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect((await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env({ AI: ai2.AI }), T0 + 24 * 3600_000, fakeGemini(...quota()).fetcher)).status).toBe(200);
  });
  it('两个都出错 502，原因写两边（不含 Key）；出错的调用也按最多可能用的量记账', async () => {
    const ai = fakeAi(new Error('upstream exploded'));
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env({ AI: ai.AI }), T0, fakeGemini(new Response('bad', { status: 403 })).fetcher);
    expect(r.status).toBe(502);
    const j = (await r.json()) as { detail: string };
    expect(j.detail).toContain('出错（HTTP 403）');
    expect(j.detail).toContain('Workers AI 出错：upstream exploded');
    expect(await used()).toBe(RESERVE);
  });
  it('备用 AI 写的草稿带标记，存进清单后后台也能看到；测试 AI 报备用 AI 和今天用量', async () => {
    const ai = fakeAi(
      { response: JSON.stringify({ drafts: [{ tone: '丢问题', text: 'Curry 今晚會先熱手嗎？', source: '' }] }), usage: { prompt_tokens: 100, completion_tokens: 50 } },
      { response: '{"ok":true}', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    );
    const d = (await (await handle(req('POST', '/v1/draft', { product: 'forecast', platform: 'x', post: POST }), env({ AI: ai.AI }), T0, fakeGemini(...quota()).fetcher)).json()) as { drafts: { text: string; engine: string }[]; engine: string };
    expect(d.engine).toBe('workers-ai');
    expect(d.drafts[0].engine).toBe('workers-ai');
    await handle(req('POST', '/v1/queue', { product: 'forecast', platform: 'x', post: POST, score: 80, draft: d.drafts[0].text, source: '', engine: 'workers-ai' }), env(), T0);
    expect((await db.prepare('SELECT engine FROM queue').first<{ engine: string }>())?.engine).toBe('workers-ai');
    const diag = (await (await handle(req('GET', '/v1/diag'), env({ AI: ai.AI }), T0, fakeGemini(...quota()).fetcher)).json()) as { models: { model: string; ok: boolean; detail: string }[] };
    expect(diag.models[3]).toMatchObject({ model: '备用 AI qwen3-30b-a3b-fp8', ok: true });
    expect(diag.models[3].detail).toMatch(/^OK（今天已用 \d+ \/ 8000）$/);
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
    // R-1、R-2（2026-10-30）：下注相关说法；原帖没有的夸大结论
    expect(checkDraft('對加密幣與體育彩池可能有間接影響', 'x')).toContain('不能说的话：彩池');
    expect(checkDraft('賠率怎麼看', 'x')).toContain('不能说的话：賠率');
    expect(checkDraft('BlackRock 的 IBIT 近日資金流入破紀錄', 'x', 'IBIT recorded $136 million inflows')).toContain('原帖没有的结论：破紀錄');
    expect(checkDraft('BTC 創歷史新高了', 'x', 'BTC hits all-time high')).toContain('原帖没有的结论：創歷史新高');
    expect(checkDraft('資金流入破紀錄', 'x', '今天資金流入破紀錄')).toEqual([]);
  });
});

describe('记录、每天上限和当天汇总', () => {
  it('同意超过每天上限 429；跳过不算；当天汇总按台湾日期；旧记录一直保留（D-4 选 B）', async () => {
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
    expect((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE post_id = 'old'").first<{ n: number }>())!.n).toBe(1);
  });
});

describe('跟帖评论清单（C136；0.3 原"待回复清单"）', () => {
  const page = (p: string, init: RequestInit & { cookie?: string; ip?: string } = {}) =>
    new Request(`https://copilot.example.test${p}`, {
      ...init,
      headers: { 'content-type': 'application/json', origin: 'https://copilot.example.test', 'cf-connecting-ip': init.ip ?? '203.0.113.9', ...(init.cookie ? { cookie: init.cookie } : {}) },
    });
  async function loginCookie(now = T0): Promise<string> {
    const r = await handle(page('/api/login', { method: 'POST', body: JSON.stringify({ password: PASS }) }), env(), now);
    expect(r.status).toBe(200);
    return r.headers.get('set-cookie')!.split(';')[0];
  }
  const save = (draft: string, id = POST.id) =>
    handle(req('POST', '/v1/queue', { product: 'forecast', platform: 'x', post: { ...POST, id }, score: 86, draft, source: 'nba.com' }), env(), T0);

  it('插件存进清单：草稿再查一遍；同一条只存一次；没填后台密码时后台页面和接口 404', async () => {
    expect(await (await save('Curry 會先熱手嗎？')).json()).toEqual({ saved: true });
    expect(await (await save('Curry 會先熱手嗎？')).json()).toEqual({ saved: false });
    expect((await save('來 Quick Come 穩賺')).status).toBe(422);
    expect((await handle(page('/'), env({ COPILOT_PASSWORD: undefined }), T0)).status).toBe(404);
    expect((await handle(page('/api/queue'), env({ COPILOT_PASSWORD: 'short' }), T0)).status).toBe(404);
    const h = await (await handle(new Request('https://c.test/health'), env(), T0)).json();
    expect(h).toMatchObject({ admin: 'ok' });
    expect(JSON.stringify(h)).not.toContain(PASS);
  });
  it('后台：没登录 401；登录后看到一键回复链接、原帖链接；"我回了"算每天上限；可以放回', async () => {
    await save('Curry 會先熱手嗎？');
    await save('勇士主場優勢大嗎？', '1850000000000000009');
    expect((await handle(page('/api/queue'), env(), T0)).status).toBe(401);
    const html = await (await handle(page('/'), env(), T0)).text();
    expect(html).toContain('跟帖评论清单');
    expect(html).toContain('用量和限额');
    const ck = await loginCookie();
    const list = (await (await handle(page('/api/queue?status=pending', { cookie: ck }), env(), T0)).json()) as { items: { id: number; replyUrl: string; postUrl: string; stale: boolean }[]; doneToday: number; cap: number };
    expect(list.items).toHaveLength(2);
    expect(list.items[1].replyUrl).toBe(`https://x.com/intent/tweet?in_reply_to=${POST.id}&text=${encodeURIComponent('Curry 會先熱手嗎？')}`);
    expect(list.items[1].postUrl).toBe(`https://x.com/hoops_demo/status/${POST.id}`);
    expect(list.items[1].stale).toBe(false);
    const mark = (id: number, status: string) => handle(page(`/api/queue/${id}`, { method: 'POST', cookie: ck, body: JSON.stringify({ status }) }), env(), T0);
    expect(await (await mark(list.items[0].id, 'done')).json()).toEqual({ ok: true, doneToday: 1 });
    expect((await mark(list.items[1].id, 'done')).status).toBe(200);
    // 上限 2：第 3 条不行
    await save('第三條', '1850000000000000010');
    const third = (await (await handle(page('/api/queue', { cookie: ck }), env(), T0)).json()) as { items: { id: number }[] };
    expect((await mark(third.items[0].id, 'done')).status).toBe(429);
    expect((await mark(list.items[0].id, 'pending')).status).toBe(200);
    expect((await mark(999999, 'skip')).status).toBe(404);
    expect((await mark(list.items[0].id, 'delete')).status).toBe(400);
    // 别的网站来的写请求 403
    expect((await handle(new Request(`https://copilot.example.test/api/queue/${list.items[0].id}`, { method: 'POST', headers: { origin: 'https://evil.example', cookie: ck }, body: '{"status":"skip"}' }), env(), T0)).status).toBe(403);
    // 会话 12 小时过期；改密码旧会话失效
    expect((await handle(page('/api/queue', { cookie: ck }), env(), T0 + 12 * 3600_000 + 1)).status).toBe(401);
    expect((await handle(page('/api/queue', { cookie: ck }), env({ COPILOT_PASSWORD: 'another_password_123456' }), T0)).status).toBe(401);
  });
  it('登录：同一 IP 错 5 次锁 15 分钟（锁着时正确密码也不行）；失败一律同一句', async () => {
    const tryPw = (pw: string, now = T0, ip = '198.51.100.7') => handle(page('/api/login', { method: 'POST', ip, body: JSON.stringify({ password: pw }) }), env(), now);
    for (let i = 0; i < 5; i++) expect(await (await tryPw('wrong')).json()).toEqual({ error: '登录失败，请稍后再试' });
    const locked = await tryPw(PASS);
    expect(locked.status).toBe(401);
    expect(await locked.json()).toEqual({ error: '登录失败，请稍后再试' });
    expect((await tryPw(PASS, T0, '198.51.100.8')).status).toBe(200);
    expect((await tryPw(PASS, T0 + 15 * 60_000 + 1)).status).toBe(200);
  });
  it('"今天"把清单也算进去：进清单、后台"我回了"；插件"同意"和后台"我回了"合起来算每天上限', async () => {
    await save('Curry 會先熱手嗎？', 'q1');
    await save('湖人今晚誰先發？', 'q2');
    const ck = await loginCookie();
    const list = (await (await handle(page('/api/queue?status=pending', { cookie: ck }), env(), T0)).json()) as { items: { id: number }[] };
    expect((await handle(page(`/api/queue/${list.items[0].id}`, { method: 'POST', cookie: ck, body: JSON.stringify({ status: 'done' }) }), env(), T0 + 60_000)).status).toBe(200);
    const t = (await (await handle(req('GET', '/v1/today'), env(), T0 + 120_000)).json()) as { saved: number; approved: number; skipped: number; items: { action: string }[] };
    expect(t).toMatchObject({ saved: 2, approved: 1, skipped: 0 });
    expect(t.items.map((x) => x.action)).toEqual(['saved', 'saved', 'done']);
    // 上限 2：后台回了 1 条，插件再同意 1 条就到了
    const log = (id: string) => handle(req('POST', '/v1/log', { product: 'forecast', platform: 'x', postId: id, action: 'approve' }), env(), T0);
    expect((await log('p1')).status).toBe(200);
    expect((await log('p2')).status).toBe(429);
    expect((await handle(page(`/api/queue/${list.items[1].id}`, { method: 'POST', cookie: ck, body: JSON.stringify({ status: 'done' }) }), env(), T0)).status).toBe(429);
  });
});

describe('0.3：清单的打分依据、筛选、删除；用量和限额', () => {
  const page = (p: string, init: RequestInit & { cookie?: string } = {}) =>
    new Request(`https://copilot.example.test${p}`, { ...init, headers: { 'content-type': 'application/json', origin: 'https://copilot.example.test', 'cf-connecting-ip': '203.0.113.9', ...(init.cookie ? { cookie: init.cookie } : {}) } });
  async function cookie(): Promise<string> {
    const r = await handle(page('/api/login', { method: 'POST', body: JSON.stringify({ password: PASS }) }), env(), T0);
    return r.headers.get('set-cookie')!.split(';')[0];
  }
  const save = (id: string, platform: 'x' | 'threads', at: number, reasons: unknown = ['NBA 焦点战', '留言多']) =>
    handle(req('POST', '/v1/queue', { product: 'forecast', platform, post: { ...POST, id }, score: 80, reasons, draft: 'Curry 會先熱手嗎？', source: '' }), env(), at);
  type Item = { id: number; product: string; platform: string; reasons: string[]; savedAt: number; postAt: number | null; handledAt: number | null };
  const list = async (ck: string, q = '') => (await (await handle(page('/api/queue?status=pending' + q, { cookie: ck }), env(), T0)).json()) as { items: Item[]; total: number; products: string[] };

  it('存进来带打分依据（最多 3 条）、项目、平台、存进来和原帖时间；按平台和台湾日期筛选', async () => {
    await save('a1', 'x', T0, ['一', '二', '三', '四', 5]);
    await save('a2', 'threads', T0 - 3 * 24 * 3600_000);
    const ck = await cookie();
    const all = await list(ck);
    expect(all.total).toBe(2);
    expect(all.products).toEqual(['forecast']);
    const a1 = all.items.find((x) => x.platform === 'x')!;
    expect(a1).toMatchObject({ product: 'forecast', reasons: ['一', '二', '三'], savedAt: T0, postAt: T0 - 120 * 60_000, handledAt: null });
    expect((await list(ck, '&platform=threads')).items.map((x) => x.platform)).toEqual(['threads']);
    const today = twDay(T0);
    expect((await list(ck, `&from=${today}&to=${today}`)).total).toBe(1);
    expect((await list(ck, `&to=${twDay(T0 - 2 * 24 * 3600_000)}`)).items.map((x) => x.platform)).toEqual(['threads']);
    // 处理过的带处理时间
    const mark = await handle(page(`/api/queue/${a1.id}`, { method: 'POST', cookie: ck, body: JSON.stringify({ status: 'skip' }) }), env(), T0 + 5000);
    expect(mark.status).toBe(200);
    const skipped = (await (await handle(page('/api/queue?status=skip', { cookie: ck }), env(), T0)).json()) as { items: Item[] };
    expect(skipped.items[0].handledAt).toBe(T0 + 5000);
  });
  it('删除：要登录、要同一来源；只删给定的；请求不对 400', async () => {
    await save('d1', 'x', T0);
    await save('d2', 'x', T0);
    await save('d3', 'threads', T0);
    const ck = await cookie();
    const ids = (await list(ck)).items.map((x) => x.id);
    const del = (body: unknown, c = ck, origin = 'https://copilot.example.test') =>
      handle(new Request('https://copilot.example.test/api/queue/delete', { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) }), env(), T0);
    expect((await del({ ids: [ids[0]] }, '')).status).toBe(401);
    expect((await del({ ids: [ids[0]] }, ck, 'https://evil.example')).status).toBe(403);
    expect((await del({ ids: [] })).status).toBe(400);
    expect((await del({ ids: ['1; DROP TABLE queue'] })).status).toBe(400);
    expect(await (await del({ ids: ids.slice(0, 2) })).json()).toEqual({ ok: true, deleted: 2 });
    expect((await list(ck)).total).toBe(1);
    // 一次超过 100 条（D1 每条语句最多 100 个参数）也能删
    for (let i = 0; i < 130; i++) await db.prepare("INSERT INTO queue (at, updated_at, product, platform, post_id, draft) VALUES (?1, ?1, 'forecast', 'x', ?2, 'd')").bind(T0, 'bulk' + i).run();
    const many = (await (await handle(page('/api/queue?status=pending', { cookie: ck }), env(), T0)).json()) as { items: { id: number }[] };
    expect(many.items).toHaveLength(131);
    expect(await (await del({ ids: many.items.map((x) => x.id) })).json()).toEqual({ ok: true, deleted: 131 });
  });
  it('用量和限额：记下每个模型的次数和 token；到了我们设的上限就跳过；上限要合法；Workers AI 最多 9500', async () => {
    const ok = { candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [] }) }] } }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10 } };
    const g = fakeGemini(new Response(JSON.stringify(ok), { status: 200 }));
    await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, g.fetcher);
    const ck = await cookie();
    const u = async () => ((await (await handle(page('/api/usage', { cookie: ck }), env(), T0)).json()) as { rows: { model: string; req: number; tokIn: number; tokOut: number; cap: number; state: string; resetAt: number }[] }).rows;
    const first = (await u()).find((r) => r.model === 'gemini-3.6-flash')!;
    expect(first).toMatchObject({ req: 1, tokIn: 120, tokOut: 40, cap: 200, state: 'ok' });
    expect(first.resetAt).toBeGreaterThan(T0);
    expect(first.resetAt - T0).toBeLessThanOrEqual(24 * 3600_000);
    const setCaps = (caps: unknown) => handle(page('/api/usage', { method: 'POST', cookie: ck, body: JSON.stringify({ caps }) }), env(), T0);
    expect((await setCaps({ 'workers-ai': 12000 })).status).toBe(400);
    expect((await setCaps({ 'gemini-3.6-flash': 0 })).status).toBe(400);
    expect((await setCaps({ 'not-a-model': 5 })).status).toBe(400);
    expect((await setCaps({ 'gemini-3.6-flash': 1, 'workers-ai': 9500 })).status).toBe(200);
    // 3.6-flash 今天已经用了 1 次 = 上限：跳过，直接问 3.8-flash
    const g2 = fakeGemini({ items: [] });
    await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, g2.fetcher);
    expect(g2.calls.map((c) => c.url.split('/models/')[1].split(':')[0])).toEqual(['gemini-3.8-flash']);
    const rows = await u();
    expect(rows.find((r) => r.model === 'gemini-3.6-flash')!.state).toBe('our_cap');
    // 全都到上限：503 写明原因
    await setCaps({ 'gemini-3.8-flash': 1, 'gemini-flash-latest': 1 });
    await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, fakeGemini({ items: [] }).fetcher);
    const r = await handle(req('POST', '/v1/score', { product: 'forecast', platform: 'x', posts: [POST] }), env(), T0, fakeGemini().fetcher);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { detail: string }).detail).toContain('gemini-3.6-flash 到了我们设的上限（每天 1 次）');
  });
});

