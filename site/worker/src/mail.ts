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
import { esc } from './http';
import { log, mask } from './util';

export const RESEND_URL = 'https://api.resend.com/emails';
export const DEFAULT_FROM = 'Quick Come <noreply@email.quickcome.online>';
export const MAIL_TIMEOUT_MS = 10_000;
export const MAIL_RETRY_DELAY_MS = 1_000;

export type MailResult = 'sent' | 'not_configured' | 'failed';

export function mailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim());
}

export function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

type MailText = (typeof MAIL.confirm)['zh-TW'];

const HTML_LANG: Record<Lang, string> = { 'zh-TW': 'zh-Hant-TW', 'zh-CN': 'zh-Hans', en: 'en' };

/**
 * 确认邮件：纯文本 + HTML 两个版本，文字一样。HTML 用邮件客户端都认的写法：表格排版、内联样式、不用外部字体和图片、不用脚本；
 * 按钮是带底色的链接（品牌色青绿 #2DD4BF 底、深蓝 #0F1B33 字、圆角），下面再放一个备用文字链接（同一个地址）。
 * 邮件里只有一个链接入口：订阅者的专属页面（links.page）；退订也在专属页面上（另有邮件头 List-Unsubscribe）。
 */
export function confirmMail(env: Env, lang: Lang, links: { page: string }): { subject: string; text: string; html: string } {
  const t: MailText = MAIL.confirm[lang];
  const prefix = environment(env) === 'production' ? '' : MAIL.envPrefix[lang];
  const text = [
    t.heading,
    '',
    t.intro,
    links.page,
    '',
    t.page,
    '',
    `${t.depositTitle}${lang === 'en' ? ': ' : '：'}${t.deposit}`,
    '',
    t.promise,
    t.unsubscribe,
    t.ignore,
  ].join('\n');
  const u = esc(links.page);
  const p = (s: string, style = '') => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#1F2A44;${style}">${esc(s)}</p>`;
  const html = `<!doctype html><html lang="${HTML_LANG[lang]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(t.subject)}</title></head>
<body style="margin:0;padding:0;background:#EEF1F5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EEF1F5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#FFFFFF;border-radius:12px;">
<tr><td style="background:#0F1B33;border-radius:12px 12px 0 0;padding:18px 24px;font-family:Arial,'PingFang TC','Microsoft JhengHei',sans-serif;font-size:18px;font-weight:bold;color:#FFFFFF;">Quick Come</td></tr>
<tr><td style="padding:24px;font-family:Arial,'PingFang TC','Microsoft JhengHei',sans-serif;">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.4;color:#0F1B33;">${esc(t.heading)}</h1>
${p(t.intro)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;"><tr><td align="center" bgcolor="#2DD4BF" style="border-radius:8px;background:#2DD4BF;">
<a href="${u}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:Arial,'PingFang TC','Microsoft JhengHei',sans-serif;font-size:16px;font-weight:bold;color:#0F1B33;text-decoration:none;border-radius:8px;">${esc(t.button)}</a>
</td></tr></table>
${p(t.fallback, 'font-size:13px;color:#5B6478;margin-bottom:4px;')}
<p style="margin:0 0 18px;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${u}" target="_blank" style="color:#0F766E;">${u}</a></p>
${p(t.page, 'font-size:14px;')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px;"><tr><td style="background:#F3FBFA;border-left:4px solid #2DD4BF;padding:12px 14px;font-family:Arial,'PingFang TC','Microsoft JhengHei',sans-serif;">
<p style="margin:0 0 4px;font-size:14px;font-weight:bold;color:#0F1B33;">${esc(t.depositTitle)}</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#1F2A44;">${esc(t.deposit)}</p>
</td></tr></table>
${p(t.promise, 'font-size:14px;')}
${p(t.unsubscribe, 'font-size:13px;color:#5B6478;')}
${p(t.ignore, 'font-size:13px;color:#5B6478;margin-bottom:0;')}
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { subject: prefix + t.subject, text, html };
}

function resendUrl(env: Env): string {
  const e = environment(env);
  const u = env.RESEND_API_URL?.trim();
  return u && (e === 'local' || e === 'test') ? u : RESEND_URL;
}

export async function send(
  env: Env,
  m: { to: string; subject: string; text: string; html?: string; unsubscribeUrl?: string },
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
    html: m.html,
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
