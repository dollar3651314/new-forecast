/**
 * 请求的总入口（index.ts 的 fetch 调这里；测试直接调 handle 并传入固定的"现在"，C106）。
 * 顺序：健康检查 → 测试版密码门（gate.ts）→ /api/*（下面的 api）→ /admin（名单页，没开通 404）→ 静态资源。
 * /api/ 下面没列出来的一律 404：**没有注册、登录、充值、下注、提现的接口**（需求单第三节底线；构建产物另由 scripts/check-dist.mjs 检查）。
 */
import { adminApi, adminEnabled } from './admin';
import { board } from './board';
import { environment, type Env } from './env';
import { gate } from './gate';
import { health } from './health';
import { error, json, notFound } from './http';
import { publicMatches } from './matches';
import { confirm, invite, subscribe, unsubscribe, visit } from './subscribe';
import { log } from './util';

/** GET /api/public/site：页面需要的环境信息（测试标识条、M-12 备用网址） */
function site(env: Env): Response {
  const b = env.BACKUP_URL?.trim();
  return json({ environment: environment(env), backupUrl: b && /^https:\/\/[^\s"'<>]+$/.test(b) ? b.replace(/\/+$/, '') : null }, 200, { 'Cache-Control': 'public, max-age=300' });
}

async function api(req: Request, env: Env, ctx: ExecutionContext, p: string, now: number): Promise<Response> {
  if (p === '/api/admin' || p.startsWith('/api/admin/')) return adminApi(req, env, p, now);
  const m = req.method;
  if (m === 'GET' || m === 'HEAD') {
    if (p === '/api/public/board') return board(env, now);
    if (p === '/api/public/matches') return publicMatches(env, now);
    if (p === '/api/public/invite') return invite(req, env);
    if (p === '/api/public/site') return site(env);
  }
  if (m === 'POST') {
    if (p === '/api/public/subscribe') return subscribe(req, env, ctx, now);
    if (p === '/api/public/confirm') return confirm(req, env, now);
    if (p === '/api/public/unsubscribe') return unsubscribe(req, env, now);
    if (p === '/api/public/visit') return visit(req, env, now);
  }
  return notFound();
}

const NOT_FOUND_PAGE = () => new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' } });

export async function handle(req: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  try {
    if (p === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) return await health(env, now);
    const blocked = await gate(req, env, p, now);
    if (blocked) return blocked;
    if (p.startsWith('/api/')) return await api(req, env, ctx, p, now);
    if (p === '/admin' || p.startsWith('/admin/') || p.startsWith('/admin.')) {
      if (!adminEnabled(env)) return NOT_FOUND_PAGE();
      // 静态资源里的 admin.html（地址 /admin）；/admin/xxx、/admin.html 都给同一页
      const page = await env.ASSETS.fetch(new Request(new URL('/admin', url), { method: 'GET', headers: req.headers }));
      const h = new Headers(page.headers);
      h.set('X-Robots-Tag', 'noindex');
      h.set('Cache-Control', 'no-store');
      return new Response(page.body, { status: page.status, headers: h });
    }
    return await env.ASSETS.fetch(req);
  } catch (e) {
    log('api.error', { path: p, error: String((e as Error)?.stack || e).slice(0, 500) });
    return error(500, 'INTERNAL_ERROR', 'internal error');
  }
}
