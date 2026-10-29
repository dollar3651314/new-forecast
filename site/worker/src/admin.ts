/**
 * 名单页的接口 /api/admin/*（一个密码，没有账号；auth.ts）。**ADMIN_PASSWORD 少于 16 个字符或没填时全部 404**，和不存在的地址一样。
 * - POST /api/admin/login {password}      → 204 + 会话 Cookie；错 401 WRONG_PASSWORD；锁着 429 LOCKED（cooldownSeconds）
 * - POST /api/admin/logout                → 204，清掉 Cookie
 * - GET  /api/admin/session               → 200 {ok:true} 或 401（页面打开时判断要不要显示登录框）
 * - GET  /api/admin/metrics               → 验证指标（M-9）：累计确认、今日新增、近 7 天平均、内测人数、按来源和"订阅者邀请"的访问 → 确认转化
 * - GET  /api/admin/subscribers?beta=1&status=confirmed&before=<id>  → 名单（邮箱打码），每页 50，最新的在前；total 按筛选条件算
 * - /api/admin/matches…                   → 焦点战增删改（matches.ts）
 * - POST /api/admin/export {password, after} → **完整邮箱**，要再输一次密码（错了同样计入锁定）；格式 qc-waitlist-v1，见 EXPORT_FORMAT 注释
 * 除 login 以外都要有效会话，没有 401。写操作只接受本站页面发起的 JSON（readJson）。
 * "今天"按台湾时间（UTC+8）算。
 * 参照：forecast main 0caa740 cf/src/admin.ts（按来源统计、导出分页、CSV 防公式），登录方式按 v1 改成密码。
 */
import { TW_OFFSET_MS } from '../../shared/rules';
import { checkPassword, clearCookies, hasSession, makeSession, passwordConfigured, SESSION_MS, sessionCookies } from './auth';
import { environment, type Env } from './env';
import { error, json, notFound, rateLimited, readJson } from './http';
import { adminMatches } from './matches';
import { iso, log, mask } from './util';

/**
 * 导出格式 qc-waitlist-v1（以后导入交易系统用）：
 * { format: "qc-waitlist-v1", exportedAt, environment, after, next, count, items: [ {
 *     email（完整、小写）, lang（zh-TW / zh-CN / en）, status（confirmed / unsubscribed；待确认的不导出）, beta（true / false，愿意内测）,
 *     src, cmp, ref（来源参数原文，可能为 null）, channel（"invite" = 订阅者邀请；其他为 src，空串 = 无来源）,
 *     inviteCode（本人的邀请码）, invitedCount（本人邀请且确认了的人数）,
 *     createdAt, confirmedAt, unsubscribedAt（UTC ISO，可能为 null） } ] }
 * 每次最多 EXPORT_PAGE 个，按 id 从小到大；next 不为 null 时用 after = next 再取下一份（页面自动取完合成一个文件）。
 * 导入时：status = unsubscribed 的人不能再发营销邮件。
 */
export const EXPORT_FORMAT = 'qc-waitlist-v1';
export const EXPORT_PAGE = 2000;
export const LIST_PAGE = 50;
const DAY = 24 * 60 * 60 * 1000;

export function adminEnabled(env: Env): boolean {
  return passwordConfigured(env);
}

/** 台湾时间今天 0 点（UTC 毫秒） */
export function taiwanDayStart(now: number): number {
  return Math.floor((now + TW_OFFSET_MS) / DAY) * DAY - TW_OFFSET_MS;
}

export async function adminApi(req: Request, env: Env, path: string, now: number): Promise<Response> {
  if (!adminEnabled(env)) return notFound();
  if (path === '/api/admin/login' && req.method === 'POST') return login(req, env, now);
  if (!(await hasSession(req, env, 'admin', now))) return error(401, 'UNAUTHORIZED', 'login required');
  if (path === '/api/admin/logout' && req.method === 'POST') {
    const h = new Headers();
    for (const c of clearCookies('admin')) h.append('Set-Cookie', c);
    return new Response(null, { status: 204, headers: h });
  }
  if (path === '/api/admin/session' && req.method === 'GET') return json({ ok: true, environment: environment(env) });
  if (path === '/api/admin/metrics' && req.method === 'GET') return metrics(env, now);
  if (path === '/api/admin/subscribers' && req.method === 'GET') return subscribers(env, new URL(req.url));
  if (path === '/api/admin/export' && req.method === 'POST') return exportJson(req, env, now);
  if (path.startsWith('/api/admin/matches')) return adminMatches(req, env, path, now);
  return notFound();
}

async function login(req: Request, env: Env, now: number): Promise<Response> {
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const c = await checkPassword(env, req, r.body.password, 'admin', now);
  if (!c.ok) return c.reason === 'locked' ? rateLimited(c.retryAfter, 'LOCKED') : error(401, 'WRONG_PASSWORD', 'wrong password');
  const h = new Headers();
  for (const ck of sessionCookies('admin', await makeSession(env, 'admin', now), SESSION_MS / 1000)) h.append('Set-Cookie', ck);
  log('admin.login', { at: iso(now) });
  return new Response(null, { status: 204, headers: h });
}

function rate(confirmed: number, visits: number): string | null {
  if (!visits) return null;
  return `${(Math.round((confirmed * 1000) / visits) / 10).toFixed(1)}%`;
}

async function metrics(env: Env, now: number): Promise<Response> {
  const today = taiwanDayStart(now);
  const [counts, todayNew, week, channels, visits] = await env.DB.batch<Record<string, number | string>>([
    env.DB.prepare(
      "SELECT SUM(status = 'CONFIRMED') AS confirmed, SUM(status = 'PENDING') AS pending, SUM(status = 'UNSUBSCRIBED') AS unsubscribed, " +
        "SUM(status = 'CONFIRMED' AND beta = 1) AS beta FROM subscribers",
    ),
    env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE confirmed_at >= ?1').bind(iso(today)),
    env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE confirmed_at >= ?1 AND confirmed_at < ?2').bind(iso(today - 7 * DAY), iso(today)),
    env.DB.prepare(
      "SELECT channel, SUM(status = 'CONFIRMED') AS confirmed, SUM(status = 'CONFIRMED' AND beta = 1) AS beta, SUM(status = 'PENDING') AS pending FROM subscribers GROUP BY channel",
    ),
    env.DB.prepare('SELECT channel, SUM(count) AS visits FROM visit_daily GROUP BY channel'),
  ]);
  const c = (counts.results?.[0] ?? {}) as Record<string, number | null>;
  const map = new Map<string, { channel: string; visits: number; confirmed: number; pending: number; beta: number }>();
  const get = (ch: string) => {
    let v = map.get(ch);
    if (!v) map.set(ch, (v = { channel: ch, visits: 0, confirmed: 0, pending: 0, beta: 0 }));
    return v;
  };
  for (const r of channels.results ?? []) Object.assign(get(String(r.channel)), { confirmed: Number(r.confirmed) || 0, beta: Number(r.beta) || 0, pending: Number(r.pending) || 0 });
  for (const r of visits.results ?? []) get(String(r.channel)).visits = Number(r.visits) || 0;
  // 订阅者邀请固定显示一行（没有数据时显示 0），方便看 M-10 有没有效果
  get('invite');
  const rows = [...map.values()]
    .map((x) => ({ ...x, rate: rate(x.confirmed, x.visits) }))
    .sort((a, b) => b.confirmed - a.confirmed || b.visits - a.visits || a.channel.localeCompare(b.channel));
  return json({
    now: iso(now),
    todayStart: iso(today),
    confirmed: c.confirmed ?? 0,
    pending: c.pending ?? 0,
    unsubscribed: c.unsubscribed ?? 0,
    beta: c.beta ?? 0,
    todayNew: Number(todayNew.results?.[0]?.n ?? 0),
    avg7: Math.round((Number(week.results?.[0]?.n ?? 0) / 7) * 10) / 10,
    channels: rows,
  });
}

interface SubRow {
  id: number;
  email: string;
  lang: string;
  status: string;
  beta: number;
  channel: string;
  src: string | null;
  cmp: string | null;
  invite_code: string;
  invites: number;
  created_at: string;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
}

const STATUSES: Record<string, string> = { pending: 'PENDING', confirmed: 'CONFIRMED', unsubscribed: 'UNSUBSCRIBED' };

async function subscribers(env: Env, url: URL): Promise<Response> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (url.searchParams.get('beta') === '1') where.push('beta = 1');
  const st = STATUSES[url.searchParams.get('status') ?? ''];
  if (st) {
    args.push(st);
    where.push(`status = ?${args.length}`);
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM subscribers ${cond}`)
    .bind(...args)
    .first<{ n: number }>();
  const before = Number(url.searchParams.get('before') ?? '0');
  const pageArgs = [...args];
  let pageCond = cond;
  if (Number.isSafeInteger(before) && before > 0) {
    pageArgs.push(before);
    pageCond = `${cond ? `${cond} AND` : 'WHERE'} id < ?${pageArgs.length}`;
  }
  pageArgs.push(LIST_PAGE);
  const r = await env.DB.prepare(
    'SELECT id, email, lang, status, beta, channel, src, cmp, invite_code, created_at, confirmed_at, unsubscribed_at, ' +
      "(SELECT COUNT(*) FROM subscribers i WHERE UPPER(i.ref) = s.invite_code AND i.channel = 'invite' AND i.confirmed_at IS NOT NULL) AS invites " +
      `FROM subscribers s ${pageCond} ORDER BY s.id DESC LIMIT ?${pageArgs.length}`,
  )
    .bind(...pageArgs)
    .all<SubRow>();
  const rows = r.results ?? [];
  return json({
    total: total?.n ?? 0,
    next: rows.length === LIST_PAGE ? rows[rows.length - 1].id : null,
    items: rows.map((x) => ({
      id: x.id,
      email: mask(x.email),
      lang: x.lang,
      status: x.status.toLowerCase(),
      beta: x.beta === 1,
      channel: x.channel,
      src: x.src,
      cmp: x.cmp,
      invites: x.invites,
      createdAt: x.created_at,
      confirmedAt: x.confirmed_at,
    })),
  });
}

async function exportJson(req: Request, env: Env, now: number): Promise<Response> {
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const c = await checkPassword(env, req, r.body.password, 'admin', now);
  if (!c.ok) return c.reason === 'locked' ? rateLimited(c.retryAfter, 'LOCKED') : error(401, 'WRONG_PASSWORD', 'wrong password');
  const after = typeof r.body.after === 'number' && Number.isSafeInteger(r.body.after) && r.body.after > 0 ? r.body.after : 0;
  const rows =
    (
      await env.DB.prepare(
        'SELECT id, email, lang, status, beta, src, cmp, ref, channel, invite_code, created_at, confirmed_at, unsubscribed_at, ' +
          "(SELECT COUNT(*) FROM subscribers i WHERE UPPER(i.ref) = s.invite_code AND i.channel = 'invite' AND i.confirmed_at IS NOT NULL) AS invites " +
          "FROM subscribers s WHERE s.id > ?1 AND s.status IN ('CONFIRMED', 'UNSUBSCRIBED') ORDER BY s.id LIMIT ?2",
      )
        .bind(after, EXPORT_PAGE)
        .all<SubRow & { ref: string | null }>()
    ).results ?? [];
  log('admin.export', { after, count: rows.length });
  return json({
    format: EXPORT_FORMAT,
    exportedAt: iso(now),
    environment: environment(env),
    after,
    next: rows.length === EXPORT_PAGE ? rows[rows.length - 1].id : null,
    count: rows.length,
    items: rows.map((x) => ({
      email: x.email,
      lang: x.lang,
      status: x.status.toLowerCase(),
      beta: x.beta === 1,
      src: x.src,
      cmp: x.cmp,
      ref: x.ref,
      channel: x.channel,
      inviteCode: x.invite_code,
      invitedCount: x.invites,
      createdAt: x.created_at,
      confirmedAt: x.confirmed_at,
      unsubscribedAt: x.unsubscribed_at,
    })),
  });
}
