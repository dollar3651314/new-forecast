/**
 * 副驾驶中转服务（agents C133，营销团队/副驾驶/技术方案.md）。接口：
 * - GET  /health                 不要令牌；不返回任何密钥的值
 * - POST /v1/score   {product, platform, posts:[{id, author, text, replies?, ageMinutes?}]}  最多 10 条 → {items:[{id, score, reasons}]}
 * - POST /v1/draft   {product, platform, post}  → {drafts:[{tone, text, source}], dropped}   只给通过程序检查的草稿
 * - POST /v1/log     {product, platform, postId, author?, score?, action: approve|skip|regenerate, draft?}  approve 超过每天上限 → 429
 * - GET  /v1/today   当天（台湾日期）的记录和计数，给插件"今天"页和晚上的小结
 * - GET  /v1/diag    每个 Gemini 模型和备用 AI 各发一个很小的请求，报状态和用时（设置页"测试 AI"；不含 Key）
 * - POST /v1/queue   {product, platform, post, score, reasons, draft, source}  存进跟帖评论清单（草稿再过一遍程序检查；同一条只存一次）
 * - GET  /           网页后台"跟帖评论清单"和"用量和限额"（COPILOT_PASSWORD 没填时 404）；接口在 /api/*（queue.ts、usage.ts）
 * 令牌：Authorization: Bearer <COPILOT_TOKEN>（≥ 24 个字符）。COPILOT_TOKEN 或 GEMINI_API_KEY 没填时 /v1/* 全部 404（默认关着，C102）。
 * Gemini 都用不了时换备用 AI（Workers AI，ai.ts）；草稿带 engine 标出是哪个 AI 写的。
 * Gemini 超额（429）返回 503 + retryAfter，插件自动排队再试；其他 Gemini 错误返回 502 + detail（原因，不含 Key）。
 * 来源：只接受 chrome-extension:// 的请求（有 ALLOWED_ORIGIN 时只接受那一个）；全站每分钟最多 60 次（2026-10-30 两个窗口一起跑会超过 30 次；插件遇到 429 自动等 60 秒）。
 */
import { checkDraft, isExcludedTopic, type Platform } from './checks';
import type { Env } from './env';
import { ask as askAi, diagnose } from './ai';
import { GeminiBusy, GeminiError, type FetchLike } from './gemini';
import { FORECAST_RULES } from '../rules/forecast';
import { ADMIN_PAGE } from './admin-page';
import { adminApi, adminEnabled, doneToday, saveToQueue } from './queue';

const RULES: Record<string, string> = { forecast: FORECAST_RULES };
const PER_MINUTE = 60;
const TW_MS = 8 * 3600_000;

export function twDay(now: number): string {
  return new Date(now + TW_MS).toISOString().slice(0, 10);
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'origin' }
    : {};
}
function json(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(origin) } });
}
const notFound = () => new Response('Not found', { status: 404 });

function originOk(env: Env, origin: string | null): boolean {
  if (!origin) return false;
  const want = env.ALLOWED_ORIGIN?.trim();
  return want ? origin === want : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

async function sha(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
async function tokenOk(env: Env, req: Request): Promise<boolean> {
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const [a, b] = await Promise.all([sha(got), sha(env.COPILOT_TOKEN ?? '')]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export function configured(env: Env): boolean {
  return (env.COPILOT_TOKEN ?? '').trim().length >= 24 && (env.GEMINI_API_KEY ?? '').trim().length > 0;
}

async function underLimit(env: Env, now: number): Promise<boolean> {
  const minute = Math.floor(now / 60_000);
  const r = await env.DB.prepare('INSERT INTO rate (minute, n) VALUES (?1, 1) ON CONFLICT (minute) DO UPDATE SET n = n + 1 RETURNING n').bind(minute).first<{ n: number }>();
  if (minute % 10 === 0) await env.DB.prepare('DELETE FROM rate WHERE minute < ?1').bind(minute - 10).run();
  return (r?.n ?? 0) <= PER_MINUTE;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const platformOf = (v: unknown): Platform | null => (v === 'x' || v === 'threads' ? v : null);
const POST_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface PostIn { id: string; author: string; text: string; replies: number | null; ageMinutes: number | null }
function readPost(v: unknown): PostIn | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id, 64);
  const text = str(o.text, 1000);
  if (!POST_ID.test(id) || !text) return null;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null);
  return { id, author: str(o.author, 64), text, replies: num(o.replies), ageMinutes: num(o.ageMinutes) };
}

async function logEvent(env: Env, now: number, e: { product: string; platform: string; postId: string; author?: string; snippet?: string; score?: number | null; action: string; draft?: string }) {
  // 记录一直保留（D-4 选 B）
  await env.DB.prepare('INSERT INTO events (at, day, product, platform, post_id, author, snippet, score, action, draft) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
    .bind(now, twDay(now), e.product, e.platform, e.postId, e.author ?? '', (e.snippet ?? '').slice(0, 120), e.score ?? null, e.action, (e.draft ?? '').slice(0, 600))
    .run();
}

async function score(env: Env, body: Record<string, unknown>, now: number, origin: string, fetcher?: FetchLike): Promise<Response> {
  const product = str(body.product, 32);
  const platform = platformOf(body.platform);
  const posts = Array.isArray(body.posts) ? body.posts.slice(0, 10).map(readPost) : [];
  if (!RULES[product] || !platform || posts.length === 0 || posts.some((p) => !p)) return json({ error: 'bad request' }, 400, origin);
  const list = posts as PostIn[];
  const excluded = new Set(list.filter((p) => isExcludedTopic(p.text)).map((p) => p.id));
  const ask = list.filter((p) => !excluded.has(p.id));
  const scored = new Map<string, { score: number; reasons: string[] }>();
  let engine = '';
  if (ask.length) {
    const r = await askAi(
      env,
      RULES[product],
      `平台：${platform === 'x' ? 'X' : 'Threads'}。下面是 Amos 首页上看到的帖子（JSON）。逐条按规则打 0～100 分，给 1～3 条简短理由（简体中文）。` +
        `只回答 JSON：{"items":[{"id":"…","score":0,"reasons":["…"]}]}。\n` +
        JSON.stringify(ask.map((p) => ({ id: p.id, author: p.author, text: p.text, replies: p.replies, ageMinutes: p.ageMinutes }))),
      now,
      fetcher,
    );
    engine = r.engine;
    const out = r.data as { items?: { id?: unknown; score?: unknown; reasons?: unknown }[] };
    for (const it of out.items ?? []) {
      const id = typeof it.id === 'string' ? it.id : '';
      if (!ask.some((p) => p.id === id)) continue;
      const s = typeof it.score === 'number' ? Math.max(0, Math.min(100, Math.round(it.score))) : 0;
      const reasons = Array.isArray(it.reasons) ? it.reasons.filter((r): r is string => typeof r === 'string').slice(0, 3).map((r) => r.slice(0, 60)) : [];
      scored.set(id, { score: s, reasons });
    }
  }
  const items = list.map((p) =>
    excluded.has(p.id) ? { id: p.id, score: 0, reasons: ['政治或排除的题目'] } : { id: p.id, ...(scored.get(p.id) ?? { score: 0, reasons: ['团队没有给出评分'] }) },
  );
  return json({ items, ...(engine ? { engine } : {}) }, 200, origin);
}

async function draft(env: Env, body: Record<string, unknown>, now: number, origin: string, fetcher?: FetchLike): Promise<Response> {
  const product = str(body.product, 32);
  const platform = platformOf(body.platform);
  const post = readPost(body.post);
  if (!RULES[product] || !platform || !post) return json({ error: 'bad request' }, 400, origin);
  if (isExcludedTopic(post.text)) return json({ drafts: [], dropped: 0, note: '政治或排除的题目，不回' }, 200, origin);
  const r = await askAi(
    env,
    RULES[product],
    `平台：${platform === 'x' ? 'X（中文算 2 个字，总共不能超过 280）' : 'Threads（不超过 500 字）'}。给下面这条帖子写 2 条不同角度的回复草稿` +
      `（一条"补资讯或数据"，一条"丢问题带讨论"），写完按规则自查。只回答 JSON：` +
      `{"drafts":[{"tone":"补资讯","text":"…","source":"数字的出处，没有数字就留空"}]}。\n帖子：` +
      JSON.stringify({ id: post.id, author: post.author, text: post.text }),
    now,
    fetcher,
  );
  const out = r.data as { drafts?: { tone?: unknown; text?: unknown; source?: unknown }[] };
  const all = (out.drafts ?? []).slice(0, 3).map((d) => ({ tone: str(d.tone, 12) || '回复', text: str(d.text, 600), source: str(d.source, 120), engine: r.engine }));
  // 有阿拉伯数字却没写出处的，也不给（C111：每个数字附来源）
  const ok = all.filter((d) => checkDraft(d.text, platform, post.text).length === 0 && (!/\d/.test(d.text) || d.source));
  await logEvent(env, now, { product, platform, postId: post.id, author: post.author, snippet: post.text, action: r.engine === 'gemini' ? 'drafted' : 'drafted-wai', draft: ok.map((d) => d.text).join(' | ') });
  return json({ drafts: ok.slice(0, 2), dropped: all.length - ok.length, engine: r.engine }, 200, origin);
}

async function log(env: Env, body: Record<string, unknown>, now: number, origin: string): Promise<Response> {
  const product = str(body.product, 32);
  const platform = platformOf(body.platform);
  const postId = str(body.postId, 64);
  const action = str(body.action, 16);
  if (!RULES[product] || !platform || !POST_ID.test(postId) || !['approve', 'skip', 'regenerate'].includes(action)) return json({ error: 'bad request' }, 400, origin);
  if (action === 'approve') {
    const cap = Math.max(1, Math.min(50, Number(env.DAILY_REPLY_CAP) || 10));
    if ((await doneToday(env, now)) >= cap) return json({ error: 'daily cap', cap }, 429, origin);
  }
  const sc = typeof body.score === 'number' ? Math.max(0, Math.min(100, Math.round(body.score))) : null;
  await logEvent(env, now, { product, platform, postId, author: str(body.author, 64), score: sc, action, draft: str(body.draft, 600) });
  return json({ ok: true }, 200, origin);
}

async function queue(env: Env, body: Record<string, unknown>, now: number, origin: string): Promise<Response> {
  const product = str(body.product, 32);
  const platform = platformOf(body.platform);
  const post = readPost(body.post);
  const draft = str(body.draft, 600);
  if (!RULES[product] || !platform || !post || !draft) return json({ error: 'bad request' }, 400, origin);
  const why = checkDraft(draft, platform, post.text);
  if (why.length) return json({ error: 'draft rejected', why }, 422, origin);
  const sc = typeof body.score === 'number' ? Math.max(0, Math.min(100, Math.round(body.score))) : null;
  const r = await saveToQueue(env, now, { product, platform, postId: post.id, author: post.author, text: post.text, ageMinutes: post.ageMinutes, score: sc, reasons: Array.isArray(body.reasons) ? body.reasons.filter((r): r is string => typeof r === 'string').map((r) => r.trim()).filter(Boolean) : [], draft, source: str(body.source, 120), engine: body.engine === 'workers-ai' ? 'workers-ai' : 'gemini' });
  return json(r, 200, origin);
}

/**
 * 当天（台湾日期）的记录：插件里的"同意 / 跳过"，加上跟帖评论清单里今天"进清单 / 我回了 / 跳过"的
 * （2026-10-30 Amos：在后台清单里回了 2 条，"今天"却是空的——原来只算插件里按"同意"的）
 */
async function today(env: Env, now: number, origin: string): Promise<Response> {
  const day = twDay(now);
  const from = Date.parse(`${day}T00:00:00+08:00`);
  const to = from + 24 * 3600_000;
  const [ev, q] = await Promise.all([
    env.DB.prepare("SELECT at, platform, post_id, author, score, action, draft FROM events WHERE day = ?1 AND action IN ('approve', 'skip') ORDER BY at").bind(day).all<{ at: number; platform: string; post_id: string; author: string; score: number | null; action: string; draft: string }>(),
    env.DB.prepare('SELECT at, updated_at, platform, post_id, author, score, draft, status, done_day FROM queue WHERE (at >= ?1 AND at < ?2) OR (updated_at >= ?1 AND updated_at < ?2) OR done_day = ?3').bind(from, to, day).all<{ at: number; updated_at: number; platform: string; post_id: string; author: string; score: number | null; draft: string; status: string; done_day: string | null }>(),
  ]);
  const items: { at: number; platform: string; author: string; score: number | null; action: string; draft: string }[] = (ev.results ?? []).map((x) => ({ at: x.at, platform: x.platform, author: x.author, score: x.score, action: x.action, draft: x.draft }));
  for (const x of q.results ?? []) {
    const base = { platform: x.platform, author: x.author, score: x.score, draft: x.draft };
    if (x.at >= from && x.at < to) items.push({ ...base, at: x.at, action: 'saved' });
    if (x.status === 'done' && x.done_day === day) items.push({ ...base, at: x.updated_at, action: 'done' });
    if (x.status === 'skip' && x.updated_at >= from && x.updated_at < to) items.push({ ...base, at: x.updated_at, action: 'skip' });
  }
  items.sort((a, b) => a.at - b.at);
  const cap = Math.max(1, Math.min(50, Number(env.DAILY_REPLY_CAP) || 10));
  const count = (a: string) => items.filter((x) => x.action === a).length;
  return json({ day, cap, approved: count('approve') + count('done'), skipped: count('skip'), saved: count('saved'), items }, 200, origin);
}

export async function handle(req: Request, env: Env, now: number, fetcher?: FetchLike): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === '/health' && req.method === 'GET') {
    return json({ status: 'UP', environment: env.ENVIRONMENT ?? 'unknown', version: env.VERSION ?? 'dev', copilot: configured(env) ? 'ok' : 'not_configured', admin: adminEnabled(env) ? 'ok' : 'not_configured' });
  }
  if ((p === '/' || p === '/queue') && req.method === 'GET') {
    if (!adminEnabled(env)) return notFound();
    return new Response(ADMIN_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
  }
  const admin = await adminApi(env, req, now);
  if (admin) return admin;
  if (!p.startsWith('/v1/') || !configured(env)) return notFound();
  const origin = req.headers.get('origin');
  if (!originOk(env, origin)) return notFound();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (!(await tokenOk(env, req))) return json({ error: 'unauthorized' }, 401, origin);
  if (!(await underLimit(env, now))) return json({ error: 'too many requests' }, 429, origin);
  try {
    if (p === '/v1/today' && req.method === 'GET') return await today(env, now, origin!);
    if (p === '/v1/diag' && req.method === 'GET') return json({ models: await diagnose(env, now, fetcher) }, 200, origin);
    if (req.method !== 'POST') return notFound();
    if (Number(req.headers.get('content-length') ?? 0) > 32_768) return json({ error: 'too large' }, 413, origin);
    let body: Record<string, unknown>;
    try {
      const b = await req.json();
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error();
      body = b as Record<string, unknown>;
    } catch {
      return json({ error: 'bad request' }, 400, origin);
    }
    if (p === '/v1/score') return await score(env, body, now, origin!, fetcher);
    if (p === '/v1/draft') return await draft(env, body, now, origin!, fetcher);
    if (p === '/v1/log') return await log(env, body, now, origin!);
    if (p === '/v1/queue') return await queue(env, body, now, origin!);
    return notFound();
  } catch (e) {
    if (e instanceof GeminiBusy) {
      console.log(JSON.stringify({ event: 'copilot.gemini_busy', detail: e.message }));
      // detail：每个模型为什么用不了（例如"Workers AI 今天用到 8000 上限"），插件照着显示
      return json({ error: 'team busy', retryAfter: 30, detail: e.message }, 503, origin);
    }
    if (e instanceof GeminiError) {
      console.log(JSON.stringify({ event: 'copilot.gemini_error', detail: e.message }));
      // detail 只有模型名和状态码（或"不是 JSON""超时"），不含 Key，给插件显示原因
      return json({ error: 'team unavailable', detail: e.message }, 502, origin);
    }
    throw e;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, Date.now());
  },
} satisfies ExportedHandler<Env>;
