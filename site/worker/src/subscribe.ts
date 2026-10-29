/**
 * 留邮箱、确认、退订、邀请（M-6、M-10；行为沿用 forecast S19 的等候页，参照 forecast main 0caa740 cf/src/waitlist.ts 改写）。
 * - 留邮箱 POST /api/public/subscribe {email, lang, beta, src, cmp, ref, website}：
 *   双重确认（只发确认邮件）；回答永远是 {"status":"check_email"}，**不透露邮箱是否已在名单**；发信在回答之后（ctx.waitUntil）。
 *   防刷：陷阱字段 website 有值时照样回答、什么都不记；同一 IP 每小时 10 次（陷阱字段也算）；同一邮箱确认邮件至少隔 10 分钟、最多 5 封。
 * - 确认 POST /api/public/confirm {token}：**只有页面上点"确认订阅"才调用**（打开邮件里的链接不会自动确认，防止邮箱的链接扫描器替人确认）。
 *   随机串不对 404；超过 7 天 410 LINK_EXPIRED；重复确认没有效果。成功后返回邀请码和私密查看密钥。
 * - 退订 POST /api/public/unsubscribe {token}：不用登录，任何状态都能退订，重复也成功。
 * - 邀请 GET /api/public/invite?k=<私密密钥>：本人查看"你邀请了几个人"（不需要登录；密钥和邀请码不同，邀请码公开在 ?ref= 里也查不了别人的数字）。
 *   一次邀请 = 别人用 ?ref=<你的邀请码> 进来留邮箱并且确认了（之后退订也照样算，因为确认过）。
 * 状态都用带旧状态的条件更新，同时两次请求只有一个生效。
 */
import { cleanAttr, inviteCodeOf, normEmail, normLang, validateEmail, type Lang } from '../../shared/rules';
import type { Env } from './env';
import { clientIp, error, json, rateLimited, readJson } from './http';
import { confirmMail, send } from './mail';
import { hit } from './ratelimit';
import { inviteCode, iso, log, sha256, token, TOKEN_RE } from './util';

export const RULES = {
  ipPerHour: 10,
  resendAfterMs: 10 * 60 * 1000,
  maxConfirmSends: 5,
  confirmValidMs: 7 * 24 * 60 * 60 * 1000,
  visitIpPerHour: 30,
};
const HOUR = 60 * 60 * 1000;

export interface Row {
  id: number;
  email: string;
  lang: Lang;
  status: 'PENDING' | 'CONFIRMED' | 'UNSUBSCRIBED';
  beta: number;
  confirm_token: string;
  confirm_sent_at: string;
  confirm_sends: number;
  unsub_token: string;
  invite_code: string;
  invite_key: string;
  confirmed_at: string | null;
}

/** 站点地址：PUBLIC_BASE_URL（正式版）或请求自己的地址（测试版 workers.dev、本机） */
export function siteBase(env: Env, req: Request): string {
  const b = env.PUBLIC_BASE_URL?.trim();
  return (b && /^https?:\/\/[^\s"'<>]+$/.test(b) ? b : new URL(req.url).origin).replace(/\/+$/, '');
}

/** ref 是不是一个已确认订阅者的邀请码：是 → 'invite'；否则用 src（没有为空串） */
export async function channelOf(db: D1Database, src: string | null, ref: string | null): Promise<string> {
  const code = inviteCodeOf(ref);
  if (code) {
    const owner = await db.prepare("SELECT id FROM subscribers WHERE invite_code = ?1 AND status = 'CONFIRMED'").bind(code).first();
    if (owner) return 'invite';
  }
  return src ?? '';
}

async function newInviteCode(db: D1Database): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const c = inviteCode();
    if (!(await db.prepare('SELECT 1 FROM subscribers WHERE invite_code = ?1').bind(c).first())) return c;
  }
  throw new Error('邀请码连续 5 次撞车');
}

export async function subscribe(req: Request, env: Env, ctx: ExecutionContext, now: number): Promise<Response> {
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const b = r.body;
  const fe = validateEmail(b.email);
  if (fe) return error(400, 'VALIDATION_FAILED', 'invalid email', [{ field: 'email', code: fe }]);
  const ipHash = await sha256(clientIp(req));
  const lim = await hit(env.DB, 'subscribe', ipHash, RULES.ipPerHour, HOUR, now);
  if (!lim.ok) return rateLimited(lim.retryAfter);
  const done = json({ status: 'check_email' });
  if (typeof b.website === 'string' && b.website.trim() !== '') {
    log('subscribe.honeypot');
    return done;
  }
  const email = normEmail(b.email as string);
  const lang = normLang(b.lang);
  const beta = b.beta === true ? 1 : 0;
  const src = cleanAttr(b.src);
  const cmp = cleanAttr(b.cmp);
  const ref = cleanAttr(b.ref);
  const channel = await channelOf(env.DB, src, ref);
  const t = iso(now);
  const confirm = token();
  const ins = await env.DB.prepare(
    'INSERT INTO subscribers (email, lang, status, beta, confirm_token, confirm_sent_at, confirm_sends, unsub_token, invite_code, invite_key, src, cmp, ref, channel, ip_hash, created_at, updated_at) ' +
      "VALUES (?1, ?2, 'PENDING', ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?5, ?5) ON CONFLICT (email) DO NOTHING",
  )
    .bind(email, lang, beta, confirm, t, token(), await newInviteCode(env.DB), token(), src, cmp, ref, channel, ipHash)
    .run();
  let send1: Row | null = null;
  if (ins.meta.changes === 1) {
    send1 = await env.DB.prepare('SELECT * FROM subscribers WHERE email = ?1').bind(email).first<Row>();
  } else {
    const row = await env.DB.prepare('SELECT * FROM subscribers WHERE email = ?1').bind(email).first<Row>();
    if (row) {
      // 恰好满 10 分钟那一毫秒可以再发（C106）
      const waited = now >= Date.parse(row.confirm_sent_at) + RULES.resendAfterMs;
      if (row.status === 'PENDING' && waited && row.confirm_sends < RULES.maxConfirmSends) {
        // 再发一封（同一个确认链接）；带旧的发送次数做条件更新，同时两次提交只发一封。勾了内测的保留（只会从没勾变成勾）
        const u = await env.DB.prepare(
          "UPDATE subscribers SET confirm_sent_at = ?1, confirm_sends = confirm_sends + 1, lang = ?2, beta = MAX(beta, ?3), updated_at = ?1 WHERE id = ?4 AND status = 'PENDING' AND confirm_sends = ?5",
        )
          .bind(t, lang, beta, row.id, row.confirm_sends)
          .run();
        if (u.meta.changes === 1) send1 = { ...row, lang };
      } else if (row.status === 'UNSUBSCRIBED' && waited) {
        // 退订过又来留：重新走一次确认（新的确认链接、新的来源）；邀请码和私密密钥不变
        const u = await env.DB.prepare(
          "UPDATE subscribers SET status = 'PENDING', confirm_token = ?1, confirm_sent_at = ?2, confirm_sends = 1, lang = ?3, beta = ?4, src = ?5, cmp = ?6, ref = ?7, channel = ?8, " +
            "confirmed_at = NULL, unsubscribed_at = NULL, updated_at = ?2 WHERE id = ?9 AND status = 'UNSUBSCRIBED'",
        )
          .bind(confirm, t, lang, beta, src, cmp, ref, channel, row.id)
          .run();
        if (u.meta.changes === 1) send1 = { ...row, lang, confirm_token: confirm };
      }
      // 已确认、没到 10 分钟、发够了：什么都不发，回答一样
    }
  }
  if (send1) {
    const site = siteBase(env, req);
    const links = {
      confirm: `${site}/confirm?t=${send1.confirm_token}`,
      invite: `${site}/invite?k=${send1.invite_key}`,
      unsubscribe: `${site}/unsubscribe?t=${send1.unsub_token}`,
    };
    const m = confirmMail(env, send1.lang, links);
    ctx.waitUntil(send(env, { to: email, subject: m.subject, text: m.text, unsubscribeUrl: links.unsubscribe }));
  }
  return done;
}

async function byColumn(env: Env, col: 'confirm_token' | 'unsub_token' | 'invite_key', raw: unknown): Promise<Row | null> {
  const t = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!TOKEN_RE.test(t)) return null;
  return env.DB.prepare(`SELECT * FROM subscribers WHERE ${col} = ?1`).bind(t).first<Row>();
}

const INVALID = () => error(404, 'LINK_INVALID', 'link not found');

async function invitedCount(db: D1Database, code: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM subscribers WHERE ref IS NOT NULL AND UPPER(ref) = ?1 AND confirmed_at IS NOT NULL AND channel = 'invite'")
    .bind(code)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

function inviteInfo(row: Row, site: string, count: number) {
  return { code: row.invite_code, key: row.invite_key, link: `${site}/?ref=${row.invite_code}`, count };
}

export async function confirm(req: Request, env: Env, now: number): Promise<Response> {
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const row = await byColumn(env, 'confirm_token', r.body.token);
  if (!row) return INVALID();
  if (row.status === 'PENDING') {
    // 恰好满 7 天的那一毫秒还有效，之后才算过期（C106）
    if (now > Date.parse(row.confirm_sent_at) + RULES.confirmValidMs) return error(410, 'LINK_EXPIRED', 'confirm link expired');
    await env.DB.prepare("UPDATE subscribers SET status = 'CONFIRMED', confirmed_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'PENDING'")
      .bind(iso(now), row.id)
      .run();
  }
  const after = (await env.DB.prepare('SELECT * FROM subscribers WHERE id = ?1').bind(row.id).first<Row>())!;
  const body: Record<string, unknown> = { status: after.status.toLowerCase(), lang: after.lang, beta: after.beta === 1 };
  if (after.status === 'CONFIRMED') body.invite = inviteInfo(after, siteBase(env, req), await invitedCount(env.DB, after.invite_code));
  return json(body);
}

export async function unsubscribe(req: Request, env: Env, now: number): Promise<Response> {
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const row = await byColumn(env, 'unsub_token', r.body.token);
  if (!row) return INVALID();
  if (row.status !== 'UNSUBSCRIBED') {
    await env.DB.prepare("UPDATE subscribers SET status = 'UNSUBSCRIBED', unsubscribed_at = ?1, updated_at = ?1 WHERE id = ?2 AND status <> 'UNSUBSCRIBED'")
      .bind(iso(now), row.id)
      .run();
  }
  return json({ status: 'unsubscribed', lang: row.lang });
}

/** GET /api/public/invite?k=…：确认过的返回邀请码、链接和人数；还没确认的只返回状态（不给邀请码） */
export async function invite(req: Request, env: Env): Promise<Response> {
  const row = await byColumn(env, 'invite_key', new URL(req.url).searchParams.get('k'));
  if (!row) return INVALID();
  const body: Record<string, unknown> = { status: row.status.toLowerCase(), lang: row.lang };
  if (row.confirmed_at) body.invite = inviteInfo(row, siteBase(env, req), await invitedCount(env.DB, row.invite_code));
  return json(body);
}

/**
 * POST /api/public/visit {src, cmp, ref}：首页的访问按"天 + channel + cmp"计数（M-9 的转化分母；没有来源的记为空串"无来源"）。
 * 页面每次浏览同一组参数只报一次；同一 IP 每小时 30 次，超过的不计也不报错（统计用，失败不影响页面）。不记 IP、设备号。
 */
export async function visit(req: Request, env: Env, now: number): Promise<Response> {
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const src = cleanAttr(r.body.src);
  const cmp = cleanAttr(r.body.cmp);
  const ref = cleanAttr(r.body.ref);
  const lim = await hit(env.DB, 'visit', await sha256(clientIp(req)), RULES.visitIpPerHour, HOUR, now);
  if (lim.ok) {
    const channel = await channelOf(env.DB, src, ref);
    await env.DB.prepare(
      'INSERT INTO visit_daily (day, channel, cmp, count) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, channel, cmp) DO UPDATE SET count = count + 1',
    )
      .bind(iso(now).slice(0, 10), channel, cmp ?? '')
      .run();
  }
  return new Response(null, { status: 204 });
}

