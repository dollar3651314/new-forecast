/**
 * 名单页的"一个密码"（Amos 2026-10-29：不用 Cloudflare Access，一个密码、没有账号；技术方案第三节）。
 * v1.1（Amos 验收："添加密码只是给后台增加登录密码，面向客户的官网不用密码"）：去掉了测试版整站密码门，密码只用在名单页。
 * - 密码是密钥 ADMIN_PASSWORD；**少于 16 个字符或没填 = 没开通**：名单页、/api/admin/* 一律 404（默认关着，C102）。
 * - 会话：登录成功发签名 Cookie，值是 `<到期毫秒>.<HMAC-SHA256 签名>`，12 小时过期；签名密钥由密码派生（SHA-256("qc-<用途>-v1" + 密码)），
 *   所以**改密码以后旧会话全部失效**。
 * - 防猜：同一 IP 15 分钟内错 5 次锁 15 分钟；全站 1 小时内错 20 次锁 1 小时（锁着时连正确的密码也不核对）。
 *   每次失败写日志（IP、时间，不记输入的内容），D1 只存 IP 的 sha256。
 *   **对外的回答不透露这些规则**（v1.1，Amos："密码输入错误的提示不要那么明确，坏人了解规则后会有针对地尝试"）：
 *   密码错、被锁（锁着时输对也一样）一律同一个回答（admin.ts authFailed），规则和锁定只写日志。
 * - 比较用固定时间算法：两边都先算 SHA-256（长度一样），再逐字节异或比较，不因第几个字符不同而提前返回。
 */
import type { Env } from './env';
import { clientIp, cookie } from './http';
import { iso, log, sha256 } from './util';

export const PASSWORD_MIN = 16;
/**
 * 名单页的地址（v1.1，Amos："后台域名最好不要用 /admin 这样的格式，很容易被人猜出来"）：密钥 ADMIN_PATH，Amos 在控制台填，
 * 例如 /qc-ops。以 / 开头、后面至少 6 个字符（Amos 2026-10-29："大于等于6个字符就可以"）、只有字母、数字和 -。仓库是公开的，所以地址不写在代码和构建产物里。
 * 页面在 ADMIN_PATH，接口在 ADMIN_PATH/api/…；没填或不合规时名单页整体 404（和 ADMIN_PASSWORD 没填一样，默认关着）。
 */
export const ADMIN_PATH_RE = /^\/[A-Za-z0-9-]{6,}$/;

export function adminPath(env: Env): string | null {
  const p = env.ADMIN_PATH?.trim();
  return p && ADMIN_PATH_RE.test(p) ? p : null;
}
export const SESSION_MS = 12 * 60 * 60 * 1000;
export const LOCK = {
  ipFails: 5,
  ipWindowMs: 15 * 60 * 1000,
  ipLockMs: 15 * 60 * 1000,
  globalFails: 20,
  globalWindowMs: 60 * 60 * 1000,
  globalLockMs: 60 * 60 * 1000,
};

export type Purpose = 'admin';
export const COOKIE: Record<Purpose, string> = { admin: 'qc_admin' };

/** 密码开通了没有（≥ 16 个字符） */
export function passwordConfigured(env: Env): boolean {
  return typeof env.ADMIN_PASSWORD === 'string' && [...env.ADMIN_PASSWORD].length >= PASSWORD_MIN;
}

const enc = new TextEncoder();

async function digest(v: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(v)));
}

/** 固定时间比较两个字符串（先各自哈希成 32 字节） */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function b64url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(password: string, purpose: Purpose): Promise<CryptoKey> {
  const raw = await digest(`qc-${purpose}-v1\u0000${password}`);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(password: string, purpose: Purpose, exp: number): Promise<string> {
  const key = await hmacKey(password, purpose);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${purpose}.${exp}`))));
}

export async function makeSession(env: Env, purpose: Purpose, now: number): Promise<string> {
  const exp = now + SESSION_MS;
  return `${exp}.${await sign(env.ADMIN_PASSWORD!, purpose, exp)}`;
}

/** 会话有效：格式对、没过期（到期那一毫秒起算过期，C106）、签名用现在的密码算得出来 */
export async function verifySession(env: Env, purpose: Purpose, value: string | null, now: number): Promise<boolean> {
  if (!passwordConfigured(env) || !value) return false;
  const m = /^(\d{13,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(now < exp) || exp - now > SESSION_MS) return false;
  return sameSecret(m[2], await sign(env.ADMIN_PASSWORD!, purpose, exp));
}

export async function hasSession(req: Request, env: Env, purpose: Purpose, now: number): Promise<boolean> {
  return verifySession(env, purpose, cookie(req, COOKIE[purpose]), now);
}

/** 名单页的 Cookie 只在 ADMIN_PATH 下有效（页面和接口都在它下面） */
export function sessionCookies(purpose: Purpose, value: string, maxAgeSec: number, path: string): string[] {
  return [`${COOKIE[purpose]}=${value}; Path=${path}; HttpOnly; Secure; Max-Age=${maxAgeSec}; SameSite=Strict`];
}

export function clearCookies(purpose: Purpose, path: string): string[] {
  return sessionCookies(purpose, '', 0, path);
}

/** 锁着吗：返回还要等多少秒（没锁返回 0）。锁到 until 之前（不含 until 那一毫秒，C106） */
export async function lockedFor(env: Env, ipHash: string, now: number): Promise<number> {
  const r = await env.DB.prepare('SELECT MAX(until) AS until FROM auth_lock WHERE scope IN (?1, ?2) AND until > ?3')
    .bind(`ip:${ipHash}`, 'global', now)
    .first<{ until: number | null }>();
  return r?.until ? Math.max(1, Math.ceil((r.until - now) / 1000)) : 0;
}

/** 记一次失败，够数就加锁。窗口是 (现在 − 窗口, 现在]：正好 15 分钟以前的那一次不算 */
export async function recordFailure(env: Env, req: Request, ipHash: string, purpose: Purpose, now: number): Promise<void> {
  log('auth.failed', { purpose, ip: clientIp(req), at: iso(now) });
  await env.DB.prepare('INSERT INTO auth_fail (ip_hash, at) VALUES (?1, ?2)').bind(ipHash, now).run();
  const [ip, all] = await env.DB.batch<{ n: number }>([
    env.DB.prepare('SELECT COUNT(*) AS n FROM auth_fail WHERE ip_hash = ?1 AND at > ?2').bind(ipHash, now - LOCK.ipWindowMs),
    env.DB.prepare('SELECT COUNT(*) AS n FROM auth_fail WHERE at > ?1').bind(now - LOCK.globalWindowMs),
  ]);
  const upsert = 'INSERT INTO auth_lock (scope, until) VALUES (?1, ?2) ON CONFLICT (scope) DO UPDATE SET until = MAX(until, excluded.until)';
  if ((ip.results?.[0]?.n ?? 0) >= LOCK.ipFails) {
    await env.DB.prepare(upsert).bind(`ip:${ipHash}`, now + LOCK.ipLockMs).run();
    log('auth.locked', { scope: 'ip', ip: clientIp(req), until: iso(now + LOCK.ipLockMs) });
  }
  if ((all.results?.[0]?.n ?? 0) >= LOCK.globalFails) {
    await env.DB.prepare(upsert).bind('global', now + LOCK.globalLockMs).run();
    log('auth.locked', { scope: 'global', until: iso(now + LOCK.globalLockMs) });
  }
}

export type CheckResult = { ok: true } | { ok: false; reason: 'locked'; retryAfter: number } | { ok: false; reason: 'wrong' };

/** 核对一次密码：先看锁，再固定时间比较；错了记失败 */
export async function checkPassword(env: Env, req: Request, input: unknown, purpose: Purpose, now: number): Promise<CheckResult> {
  const ipHash = await sha256(clientIp(req));
  const wait = await lockedFor(env, ipHash, now);
  if (wait > 0) {
    log('auth.rejected_locked', { purpose, ip: clientIp(req), at: iso(now), retryAfterSeconds: wait });
    return { ok: false, reason: 'locked', retryAfter: wait };
  }
  const ok = typeof input === 'string' && input.length <= 1024 && (await sameSecret(input, env.ADMIN_PASSWORD!));
  if (ok) return { ok: true };
  await recordFailure(env, req, ipHash, purpose, now);
  return { ok: false, reason: 'wrong' };
}
