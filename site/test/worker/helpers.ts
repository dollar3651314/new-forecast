/**
 * Worker 测试工具：Miniflare 的本地 D1（真实 SQLite）、执行迁移、假的 Env 和 ExecutionContext、外部服务的替身、固定时钟（C106）。
 * 参照：forecast main 0caa740 cf/test/helpers.ts。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { handle } from '../../worker/src/app';
import type { Env } from '../../worker/src/env';

export const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** 测试用的密码（不是任何环境的真实密码；≥ 16 个字符） */
export const PW = 'ci_only_password_0123456789';
/** 测试用的名单页地址（不是任何环境的真实地址） */
export const AP = '/qc-ops-test-0001';
/** 固定的"现在"：2026-10-29 04:00:00 UTC = 台湾时间 12:00 */
export const T0 = Date.UTC(2026, 9, 29, 4, 0, 0);

export function migrationStatements(): string[] {
  const dir = path.join(SITE_DIR, 'migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
    );
}

export async function newDb(): Promise<{ dispose: () => Promise<void>; db: D1Database }> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: path.join(SITE_DIR, 'test/wrangler.test.toml'),
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const db = proxy.env.DB;
  await db.batch(migrationStatements().map((s) => db.prepare(s)));
  return { dispose: proxy.dispose, db };
}

export function testEnv(db: D1Database, over: Partial<Env> = {}): Env {
  return {
    DB: db,
    ASSETS: { fetch: async (r: Request) => new Response(`asset:${new URL(r.url).pathname}`) } as unknown as Fetcher,
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: 'https://www.example.test',
    MAIL_FROM: 'Quick Come <noreply@mail.example.test>',
    RESEND_API_KEY: 'ci_only_resend_key',
    ADMIN_PASSWORD: PW,
    ADMIN_PATH: AP,
    ...over,
  };
}

export function testCtx(): ExecutionContext & { flush(): Promise<void> } {
  const tasks: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      tasks.push(p);
    },
    passThroughOnException() {},
    props: {},
    async flush() {
      await Promise.all(tasks.splice(0));
    },
  } as unknown as ExecutionContext & { flush(): Promise<void> };
}

export interface Sent {
  auth: string | null;
  body: { from: string; to: string[]; subject: string; text: string; html?: string; headers?: Record<string, string> };
}

/** 替身：拦下全局 fetch。Resend 记下邮件、返回 resendStatus；其他地址交给 handlers（按 URL 前缀），没有的 599 */
export function stubFetch(handlers: Record<string, (req: Request) => Response | Promise<Response>> = {}, resendStatus = 200) {
  const mails: Sent[] = [];
  const calls: string[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    calls.push(req.url);
    if (req.url === 'https://api.resend.com/emails') {
      mails.push({ auth: req.headers.get('Authorization'), body: await req.json() });
      return new Response(JSON.stringify({ id: 'x' }), { status: resendStatus });
    }
    for (const [prefix, h] of Object.entries(handlers)) if (req.url.startsWith(prefix)) return h(req);
    return new Response('no stub', { status: 599 });
  };
  return { fn, mails, calls };
}

let ipSeq = 0;
/** 每个测试用自己的 IP（C80），互不影响限次 */
export function freshIp(): string {
  ipSeq++;
  return `203.0.${(ipSeq >> 8) & 0xff}.${ipSeq & 0xff}`;
}

export function req(method: string, pathname: string, opts: { body?: unknown; ip?: string; cookie?: string; headers?: Record<string, string> } = {}): Request {
  const h: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? '198.51.100.7', ...opts.headers };
  if (opts.body !== undefined) h['Content-Type'] = 'application/json';
  if (opts.cookie) h.Cookie = opts.cookie;
  return new Request(`https://www.example.test${pathname}`, { method, headers: h, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

/** 调 handle（整条路由），时间固定 */
export async function call(env: Env, r: Request, now = T0, ctx = testCtx()): Promise<Response> {
  const res = await handle(r, env, ctx, now);
  await ctx.flush();
  return res;
}

export function links(text: string): string[] {
  return text.match(/https:\/\/\S+/g) ?? [];
}

export function param(link: string, name: string): string {
  return new URL(link).searchParams.get(name) ?? '';
}

/** 从 Set-Cookie 里取 name=value（只要值，给下一次请求的 Cookie 头用） */
export function cookieFrom(res: Response, name: string): string {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.split(';')[0];
  return '';
}

/** 邮件里专属页面的链接（纯文本版里唯一的链接）和退订地址（邮件头 List-Unsubscribe） */
export function mailLinks(mail: Sent): { pageUrl: string; key: string; unsubUrl: string } {
  const pageUrl = links(mail.body.text)[0];
  const unsubUrl = (mail.body.headers?.['List-Unsubscribe'] ?? '').replace(/^<|>$/g, '');
  return { pageUrl, key: param(pageUrl, 'k'), unsubUrl };
}

/** 留邮箱 → 从替身邮件里拿专属页面的链接 → 打开（页面脚本 POST 确认），返回链接和专属页面的回答 */
export async function subscribeAndConfirm(env: Env, mails: Sent[], email: string, extra: Record<string, unknown> = {}, now = T0) {
  const before = mails.length;
  const r = await call(env, req('POST', '/api/public/subscribe', { body: { email, lang: 'zh-TW', ...extra }, ip: freshIp() }), now);
  if (r.status !== 200) throw new Error(`subscribe ${r.status}`);
  const mail = mails[before];
  if (!mail) throw new Error('no mail sent');
  const l = mailLinks(mail);
  const c = await call(env, req('POST', '/api/public/subscription', { body: { key: l.key }, ip: freshIp() }), now);
  return { ...l, confirmRes: (await c.json()) as Record<string, unknown> };
}
