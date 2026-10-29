/**
 * 请求的总入口（index.ts 的 fetch 调这里；测试直接调 handle 并传入固定的"现在"，C106）。
 * 顺序：健康检查 → 名单页（密钥 ADMIN_PATH 的地址；页面和 ADMIN_PATH/api/*）→ /api/*（下面的 api）→ 静态资源。
 * 名单页的地址不写在代码里（仓库公开，v1.1 Amos："后台不要用 /admin 这样容易猜的地址"）。/admin、/api/admin/*、名单页的 HTML 文件 /console.html
 * 都和普通不存在的地址一模一样（页面：首页的"找不到"；接口：404 JSON），不暴露"这里有后台"。
 * 正式版和测试版都是除 /assets/* 以外先进 Worker（wrangler.toml run_worker_first），这样名单页的地址和 /console.html 才能由这里决定。
 * 官网的公开页面在测试版和正式版都**不要密码**（v1.1，Amos："添加密码只是给后台增加登录密码"）；只有名单页要密码。
 * 不是正式版（测试版、本机）时：每个回答加 X-Robots-Tag: noindex，/robots.txt 禁止收录整站（测试版 run_worker_first = true，静态页面也经过这里）。
 * /api/ 下面没列出来的一律 404：**没有注册、登录、充值、下注、提现的接口**（需求单第三节底线；构建产物另由 scripts/check-dist.mjs 检查）。
 */
import { adminApi, adminEnabled } from './admin';
import { adminPath } from './auth';
import { board } from './board';
import { environment, type Env } from './env';
import { health } from './health';
import { error, json, notFound } from './http';
import { publicMatches } from './matches';
import { confirm, subscribe, subscription, subscriptionResend, subscriptionResubscribe, subscriptionUnsubscribe, unsubscribe, visit } from './subscribe';
import { log } from './util';

/** GET /api/public/site：页面需要的环境信息（测试标识条、M-12 备用网址） */
function site(env: Env): Response {
  const b = env.BACKUP_URL?.trim();
  return json({ environment: environment(env), backupUrl: b && /^https:\/\/[^\s"'<>]+$/.test(b) ? b.replace(/\/+$/, '') : null }, 200, { 'Cache-Control': 'public, max-age=300' });
}

async function api(req: Request, env: Env, ctx: ExecutionContext, p: string, now: number): Promise<Response> {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD') {
    if (p === '/api/public/board') return board(env, now);
    if (p === '/api/public/matches') return publicMatches(env, now);
    if (p === '/api/public/site') return site(env);
  }
  if (m === 'POST') {
    if (p === '/api/public/subscribe') return subscribe(req, env, ctx, now);
    if (p === '/api/public/subscription') return subscription(req, env, now);
    if (p === '/api/public/subscription/resend') return subscriptionResend(req, env, ctx, now);
    if (p === '/api/public/subscription/unsubscribe') return subscriptionUnsubscribe(req, env, now);
    if (p === '/api/public/subscription/resubscribe') return subscriptionResubscribe(req, env, now);
    if (p === '/api/public/confirm') return confirm(req, env, now);
    if (p === '/api/public/unsubscribe') return unsubscribe(req, env, now);
    if (p === '/api/public/visit') return visit(req, env, now);
  }
  return notFound();
}

/** 构建产物里名单页的 HTML（vite.config.ts 的 console 入口）：只在 ADMIN_PATH 下由这里取出来给 */
// 用不带 .html 的地址取（静态资源默认会把 /console.html 跳转到 /console）
const ADMIN_ASSET = '/console';
const ADMIN_ASSET_RE = /^\/console(?:\.html)?\/?$/i;

/** 名单页：ADMIN_PATH 下的页面和接口；不是名单页的地址返回 null（继续往下走） */
async function adminRoute(req: Request, env: Env, url: URL, now: number): Promise<Response | null> {
  const base = adminPath(env);
  if (!base || !adminEnabled(env)) return null;
  const p = url.pathname;
  if (p === base || p === `${base}/`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
    const page = await env.ASSETS.fetch(new Request(new URL(ADMIN_ASSET, url), { method: 'GET', headers: req.headers }));
    const h = new Headers(page.headers);
    h.set('X-Robots-Tag', 'noindex');
    h.set('Cache-Control', 'no-store');
    h.set('Referrer-Policy', 'no-referrer');
    return new Response(page.body, { status: page.status, headers: h });
  }
  if (p.startsWith(`${base}/api/`)) return adminApi(req, env, `/api/admin/${p.slice(base.length + 5)}`, now);
  return null;
}

/** 测试版、本机：整站禁止收录 */
const ROBOTS_NOINDEX = 'User-agent: *\nDisallow: /\n';

function noindex(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export async function handle(req: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Response> {
  const res = await route(req, env, ctx, now);
  return environment(env) === 'production' ? res : noindex(res);
}

async function route(req: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  try {
    if (p === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) return await health(env, now);
    const admin = await adminRoute(req, env, url, now);
    if (admin) return admin;
    // 名单页的 HTML 文件不能直接打开（和不存在的地址一样）
    if (ADMIN_ASSET_RE.test(p)) return env.ASSETS.fetch(new Request(new URL('/__not_found__', url), req));
    if (p.startsWith('/api/')) return await api(req, env, ctx, p, now);
    if (p === '/robots.txt' && environment(env) !== 'production') {
      return new Response(ROBOTS_NOINDEX, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    }
    return await env.ASSETS.fetch(req);
  } catch (e) {
    log('api.error', { path: p, error: String((e as Error)?.stack || e).slice(0, 500) });
    return error(500, 'INTERNAL_ERROR', 'internal error');
  }
}
