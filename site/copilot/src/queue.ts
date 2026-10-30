/**
 * 待回复清单（agents C136）：插件存进来，Amos 在网页后台点"一键回复"→ 官方回复窗口 → 本人按发送 → 回来点"我回了"。
 * - 插件用（令牌）：POST /v1/queue {product, platform, post:{id, author, text, ageMinutes}, score, draft, source}；同一条帖子只存一次。
 * - 后台用（密码登录后的会话 Cookie）：GET /api/queue?status=pending|done|skip、POST /api/queue/<id> {status}、POST /api/login、POST /api/logout。
 * 登录：密钥 COPILOT_PASSWORD（≥ 16 个字符，没填时后台 404）；同一 IP 15 分钟错 5 次锁 15 分钟，全站 1 小时错 20 次锁 1 小时；
 * 失败一律回答同一句（不透露锁定规则，C128）；会话 12 小时，签名密钥由密码派生，改密码旧会话全部失效。
 */
import type { Env } from './env';

export const SESSION_MS = 12 * 3600_000;
const LOCK = { ipWindow: 15 * 60_000, ipMax: 5, ipLock: 15 * 60_000, allWindow: 3600_000, allMax: 20, allLock: 3600_000 };
const KEEP_MS = 30 * 24 * 3600_000;
const TW_MS = 8 * 3600_000;
const twDay = (now: number) => new Date(now + TW_MS).toISOString().slice(0, 10);
const COOKIE = 'qc_cp';

export function adminEnabled(env: Env): boolean {
  return (env.COPILOT_PASSWORD ?? '').length >= 16;
}

export function replyUrl(platform: 'x' | 'threads', id: string, text: string): string {
  const t = encodeURIComponent(text);
  return platform === 'x'
    ? `https://x.com/intent/tweet?in_reply_to=${encodeURIComponent(id)}&text=${t}`
    : `https://www.threads.com/intent/post?reply_post_shortcode=${encodeURIComponent(id)}&text=${t}`;
}
export function postUrl(platform: 'x' | 'threads', id: string, author: string): string {
  const a = author.replace(/^@/, '');
  return platform === 'x' ? `https://x.com/${encodeURIComponent(a || 'i')}/status/${encodeURIComponent(id)}` : `https://www.threads.com/@${encodeURIComponent(a)}/post/${encodeURIComponent(id)}`;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
const enc = new TextEncoder();
async function hmac(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('copilot-session:' + (env.COPILOT_PASSWORD ?? ''))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
async function ipHash(req: Request): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('copilot-ip:' + ip)))].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sessionOk(env: Env, req: Request, now: number): Promise<boolean> {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`));
  if (!m || Number(m[1]) <= now) return false;
  return same(m[2], await hmac(env, m[1]));
}

async function login(env: Env, req: Request, now: number): Promise<Response> {
  const fail = () => json({ error: '登录失败，请稍后再试' }, 401);
  const ip = await ipHash(req);
  const locked = await env.DB.prepare('SELECT MAX(until) AS u FROM auth_lock WHERE scope IN (?1, ?2) AND until > ?3').bind('ip:' + ip, 'all', now).first<{ u: number | null }>();
  let body: { password?: unknown } = {};
  try { body = (await req.json()) as { password?: unknown }; } catch { /* 当成密码错 */ }
  if (locked?.u) return fail();
  if (typeof body.password === 'string' && (await same(body.password, env.COPILOT_PASSWORD ?? ''))) {
    const exp = String(now + SESSION_MS);
    const cookie = `${COOKIE}=${exp}.${await hmac(env, exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }
  await env.DB.batch([env.DB.prepare('INSERT INTO auth_fail (ip, at) VALUES (?1, ?2)').bind(ip, now), env.DB.prepare('DELETE FROM auth_fail WHERE at < ?1').bind(now - LOCK.allWindow)]);
  const c = await env.DB.prepare('SELECT SUM(CASE WHEN ip = ?1 AND at > ?2 THEN 1 ELSE 0 END) AS mine, COUNT(*) AS everyone FROM auth_fail WHERE at > ?3').bind(ip, now - LOCK.ipWindow, now - LOCK.allWindow).first<{ mine: number; everyone: number }>();
  const up = 'INSERT INTO auth_lock (scope, until) VALUES (?1, ?2) ON CONFLICT (scope) DO UPDATE SET until = MAX(until, excluded.until)';
  if ((c?.mine ?? 0) >= LOCK.ipMax) await env.DB.prepare(up).bind('ip:' + ip, now + LOCK.ipLock).run();
  if ((c?.everyone ?? 0) >= LOCK.allMax) await env.DB.prepare(up).bind('all', now + LOCK.allLock).run();
  console.log(JSON.stringify({ event: 'copilot.login_failed', ip }));
  return fail();
}

const cap = (env: Env) => Math.max(1, Math.min(50, Number(env.DAILY_REPLY_CAP) || 10));
/** 今天回了几条：插件"同意"（events.approve）+ 后台"我回了"（queue.done），两边合起来算每天上限（2026-10-30） */
export async function doneToday(env: Env, now: number): Promise<number> {
  const day = twDay(now);
  const [a, b] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM queue WHERE status = 'done' AND done_day = ?1").bind(day).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE day = ?1 AND action = 'approve'").bind(day).first<{ n: number }>(),
  ]);
  return (a?.n ?? 0) + (b?.n ?? 0);
}

/** 后台的接口（/api/*）；不是后台的地址返回 null */
export async function adminApi(env: Env, req: Request, now: number): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!p.startsWith('/api/')) return null;
  if (!adminEnabled(env)) return new Response('Not found', { status: 404 });
  if (req.method === 'POST') {
    // 只接受本站页面发来的写请求（防跨站提交）
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'forbidden' }, 403);
  }
  if (p === '/api/login' && req.method === 'POST') return login(env, req, now);
  if (p === '/api/logout' && req.method === 'POST') return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  if (!(await sessionOk(env, req, now))) return json({ error: '请重新登录' }, 401);
  if (p === '/api/queue' && req.method === 'GET') {
    const status = ['pending', 'done', 'skip'].includes(url.searchParams.get('status') ?? '') ? url.searchParams.get('status')! : 'pending';
    const r = await env.DB.prepare(`SELECT id, at, platform, post_id, author, snippet, post_at, score, draft, source, engine, status FROM queue WHERE status = ?1 ORDER BY ${status === 'pending' ? 'at DESC' : 'updated_at DESC'} LIMIT 200`).bind(status).all<{ id: number; at: number; platform: 'x' | 'threads'; post_id: string; author: string; snippet: string; post_at: number | null; score: number | null; draft: string; source: string; engine: string; status: string }>();
    const items = (r.results ?? []).map((x) => ({
      id: x.id, platform: x.platform, author: x.author, snippet: x.snippet, score: x.score, draft: x.draft, source: x.source, engine: x.engine, status: x.status, savedAt: x.at,
      stale: (x.post_at ?? x.at) < now - 24 * 3600_000,
      replyUrl: replyUrl(x.platform, x.post_id, x.draft), postUrl: postUrl(x.platform, x.post_id, x.author),
    }));
    return json({ items, doneToday: await doneToday(env, now), cap: cap(env) });
  }
  const m = p.match(/^\/api\/queue\/(\d{1,10})$/);
  if (m && req.method === 'POST') {
    let status = '';
    try { status = String(((await req.json()) as { status?: unknown }).status ?? ''); } catch { /* 下面判 400 */ }
    if (!['pending', 'done', 'skip'].includes(status)) return json({ error: '请求不对' }, 400);
    if (status === 'done' && (await doneToday(env, now)) >= cap(env)) return json({ error: `今天已经回了 ${cap(env)} 条，到上限了` }, 429);
    const r = await env.DB.prepare('UPDATE queue SET status = ?1, updated_at = ?2, done_day = CASE WHEN ?1 = \'done\' THEN ?3 ELSE NULL END WHERE id = ?4').bind(status, now, twDay(now), Number(m[1])).run();
    if (!r.meta.changes) return json({ error: '这条已经不在了，请刷新' }, 404);
    return json({ ok: true, doneToday: await doneToday(env, now) });
  }
  return new Response('Not found', { status: 404 });
}

/** 插件存一条进清单（调用方已经核对过令牌和来源）；同一条帖子只存一次 */
export async function saveToQueue(env: Env, now: number, q: { product: string; platform: 'x' | 'threads'; postId: string; author: string; text: string; ageMinutes: number | null; score: number | null; draft: string; source: string; engine?: string }): Promise<{ saved: boolean }> {
  const r = await env.DB.prepare(
    'INSERT INTO queue (at, updated_at, product, platform, post_id, author, snippet, post_at, score, draft, source, engine) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT (platform, post_id) DO NOTHING',
  )
    .bind(now, q.product, q.platform, q.postId, q.author, q.text.slice(0, 280), q.ageMinutes == null ? null : now - q.ageMinutes * 60_000, q.score, q.draft.slice(0, 600), q.source.slice(0, 120), q.engine === 'workers-ai' ? 'workers-ai' : 'gemini')
    .run();
  await env.DB.prepare("DELETE FROM queue WHERE at < ?1 AND status != 'pending'").bind(now - KEEP_MS).run();
  return { saved: r.meta.changes === 1 };
}
