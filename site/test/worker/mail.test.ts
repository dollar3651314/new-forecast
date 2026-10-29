/** 确认邮件：三种语言、纯文本 + HTML（按钮）、只有一个链接（专属页面）、充值提醒（只讲 BEP20，不点名交易所）；Resend 的超时、重试和"未开通"。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import MAIL from '../../worker/content/mail.json';
import { confirmMail, send } from '../../worker/src/mail';
import type { Env } from '../../worker/src/env';
import { LANGS } from '../../shared/rules';

afterEach(() => vi.unstubAllGlobals());

const env = (over: Partial<Env> = {}) => ({ ENVIRONMENT: 'production', RESEND_API_KEY: 'ci_only_resend_key', ...over }) as Env;
const links = { page: 'https://s/subscription?k=2&lang=zh-TW' };

describe('确认邮件的文字', () => {
  it.each(LANGS)('%s：纯文本和 HTML 都只有专属页面一个链接；HTML 有按钮（品牌色、表格写法、内联样式）和备用文字链接；有 BEP20 和 TRC20 提醒、退订说明；不点名交易所；正式版标题没有测试标识', (lang) => {
    const m = confirmMail(env(), lang, links);
    expect(m.text.match(/https?:\/\/\S+/g)).toEqual([links.page]);
    const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, '&'));
    expect(hrefs).toEqual([links.page, links.page]);
    const t = MAIL.confirm[lang];
    // 按钮：青绿底、深蓝字、圆角，用表格包（邮件客户端兼容）
    expect(m.html).toMatch(new RegExp(`<td[^>]*bgcolor="#2DD4BF"[^>]*>\\s*<a [^>]*color:#0F1B33[^>]*border-radius:8px[^>]*>${t.button}</a>`));
    expect(m.html).not.toMatch(/<script|<link|<style|https?:\/\/(?!s\/)/i);
    for (const k of ['heading', 'intro', 'page', 'deposit', 'promise', 'unsubscribe', 'ignore'] as const) {
      expect(m.text).toContain(t[k]);
      expect(m.html).toContain(t[k].replace(/"/g, '&quot;'));
    }
    // 备用文字链接的说明只在 HTML 版（纯文本版本身就是文字链接）
    expect(m.html).toContain(t.fallback);
    expect(m.text).toContain('BEP20');
    expect(m.text).toContain('TRC20');
    expect(m.text).not.toMatch(/\{\w+\}/);
    expect(m.text).not.toMatch(/MAX|BitoPro|Binance|幣安|币安|OKX/i);
    expect(m.subject).toBe(MAIL.confirm[lang].subject);
  });

  it('测试版标题加测试标识', () => {
    expect(confirmMail(env({ ENVIRONMENT: 'staging' }), 'zh-CN', links).subject).toBe('[测试环境] 请确认订阅 Quick Come 上线通知');
  });

  it('三种语言的字段一样；不出现内部编号和英文技术词', () => {
    const keys = (l: (typeof LANGS)[number]) => Object.keys(MAIL.confirm[l]).sort();
    expect(keys('zh-CN')).toEqual(keys('zh-TW'));
    expect(keys('en')).toEqual(keys('zh-TW'));
    const all = JSON.stringify(MAIL.confirm);
    expect(all).not.toMatch(/\bM-\d|\bC-?\d{2,3}\b|JSON|\bref\b|\bsrc\b|\bcmp\b/);
  });

  it('繁中用台湾用语（電子信箱、連結），不用"郵箱""鏈接"', () => {
    const tw = JSON.stringify(MAIL.confirm['zh-TW']);
    expect(tw).toContain('電子信箱');
    expect(tw).not.toMatch(/郵箱|鏈接|網絡|默認/);
  });
});

describe('Resend', () => {
  it('没填 key：not_configured，不发请求', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await send(env({ RESEND_API_KEY: ' ' }), { to: 'a@b.co', subject: 's', text: 't' })).toBe('not_configured');
    expect(f).not.toHaveBeenCalled();
  });

  it('超时（替身一直不回）：按超时放弃，再试一次，最后 failed，不会一直卡住（C81）', async () => {
    const f = vi.fn((_u: unknown, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError')))));
    vi.stubGlobal('fetch', f);
    const t = Date.now();
    expect(await send(env(), { to: 'a@b.co', subject: 's', text: 't' }, { timeoutMs: 50, retryDelayMs: 10 })).toBe('failed');
    expect(f).toHaveBeenCalledTimes(2);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('5xx、429 再试一次；4xx 不重试', async () => {
    const seq = [503, 200];
    const f = vi.fn(async () => new Response('{}', { status: seq.shift() }));
    vi.stubGlobal('fetch', f);
    expect(await send(env(), { to: 'a@b.co', subject: 's', text: 't' }, { retryDelayMs: 1 })).toBe('sent');
    expect(f).toHaveBeenCalledTimes(2);
    const g = vi.fn(async () => new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', g);
    expect(await send(env(), { to: 'a@b.co', subject: 's', text: 't' }, { retryDelayMs: 1 })).toBe('failed');
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('RESEND_API_URL 只在本机 / 测试环境生效，正式版和测试版忽略', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: string) => (urls.push(u), new Response('{}')));
    await send(env({ ENVIRONMENT: 'production', RESEND_API_URL: 'http://127.0.0.1:9/emails' }), { to: 'a@b.co', subject: 's', text: 't' });
    await send(env({ ENVIRONMENT: 'local', RESEND_API_URL: 'http://127.0.0.1:9/emails' }), { to: 'a@b.co', subject: 's', text: 't' });
    expect(urls).toEqual(['https://api.resend.com/emails', 'http://127.0.0.1:9/emails']);
  });
});
