/**
 * 发确认邮件：Resend 的 HTTP 接口（https://resend.com/docs/api-reference/emails/send-email）。
 * - key 是密钥 RESEND_API_KEY；没填时不发、返回 not_configured（"发信未开通"，不是故障，C103），留邮箱照常回答。
 * - 外部调用（C81）：每次请求超时 10 秒；网络错误、超时、5xx、429 隔 1 秒再试一次（最多 2 次），其余错误不重试；
 *   发信在回答之后（ctx.waitUntil）进行，不拖慢留邮箱，也不在数据库事务里调用。
 * - 日志里邮箱打码，不打印 key。
 * 参照：forecast main 0caa740 cf/src/mail.ts。
 */
import type { Lang } from '../../shared/rules';
import MAIL from '../content/mail.json';
import { environment, type Env } from './env';
import { log, mask } from './util';

export const RESEND_URL = 'https://api.resend.com/emails';
export const DEFAULT_FROM = 'Quick Come <noreply@fc-email.quickcome.online>';
export const MAIL_TIMEOUT_MS = 10_000;
export const MAIL_RETRY_DELAY_MS = 1_000;

export type MailResult = 'sent' | 'not_configured' | 'failed';

export function mailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim());
}

export function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export function confirmMail(env: Env, lang: Lang, links: { confirm: string; invite: string; unsubscribe: string }): { subject: string; text: string } {
  const t = MAIL.confirm[lang];
  const prefix = environment(env) === 'production' ? '' : MAIL.envPrefix[lang];
  return { subject: prefix + t.subject, text: render(t.body, links) };
}

function resendUrl(env: Env): string {
  const e = environment(env);
  const u = env.RESEND_API_URL?.trim();
  return u && (e === 'local' || e === 'test') ? u : RESEND_URL;
}

export async function send(
  env: Env,
  m: { to: string; subject: string; text: string; unsubscribeUrl?: string },
  opts: { timeoutMs?: number; retryDelayMs?: number } = {},
): Promise<MailResult> {
  const key = env.RESEND_API_KEY?.trim();
  if (!key) {
    log('mail.not_configured', { to: mask(m.to) });
    return 'not_configured';
  }
  const payload = {
    from: env.MAIL_FROM?.trim() || DEFAULT_FROM,
    to: [m.to],
    subject: m.subject,
    text: m.text,
    headers: m.unsubscribeUrl ? { 'List-Unsubscribe': `<${m.unsubscribeUrl}>` } : undefined,
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? MAIL_RETRY_DELAY_MS));
    try {
      const res = await fetch(resendUrl(env), {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.timeoutMs ?? MAIL_TIMEOUT_MS),
      });
      if (res.ok) {
        log('mail.sent', { to: mask(m.to) });
        return 'sent';
      }
      const body = (await res.text()).slice(0, 300);
      log('mail.failed', { to: mask(m.to), status: res.status, attempt, body });
      if (res.status < 500 && res.status !== 429) return 'failed';
    } catch (e) {
      log('mail.failed', { to: mask(m.to), attempt, error: String((e as Error)?.name || e) });
    }
  }
  return 'failed';
}
