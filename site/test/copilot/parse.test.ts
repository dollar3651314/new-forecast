// @vitest-environment jsdom
/**
 * 插件的读取适配器（copilot/extension/parse.js）：只从页面上已显示的元素里取帖子，读不到就不猜；
 * 官方回复窗口的地址；插件只要最少的权限（不读 Cookie、不要 tabs、不要任意网站）。页面片段是按平台结构写的示例，不是抓来的数据。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type Post = { id: string; author: string; text: string; replies: number | null; ageMinutes: number | null };
type Parse = {
  blockedReason(d: Document, loc: { pathname: string }): string | null;
  platformOf(h: string): string | null;
  readPosts(d: Document, h: string, now: number): Post[];
  replyUrl(p: string, id: string, t: string): string;
  num(s: string): number | null;
};
let P: Parse;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
beforeAll(async () => {
  await import('../../copilot/extension/parse.js');
  P = (globalThis as unknown as { QCParse: Parse }).QCParse;
});

const xTweet = (id: string, user: string, text: string, replyLabel = '86 回覆。回覆', minsAgo = 120) => `
  <article data-testid="tweet">
    <a href="/${user}">頭像</a>
    <a href="/${user}/status/${id}"><time datetime="${new Date(NOW - minsAgo * 60000).toISOString()}">2小時</time></a>
    <div data-testid="tweetText"><span>${text}</span></div>
    <div><button data-testid="reply" aria-label="${replyLabel}"></button></div>
  </article>`;

describe('X', () => {
  it('取帖子编号、作者、文字、留言数、发布了几分钟；没有文字的（只有图片）跳过', () => {
    document.body.innerHTML = xTweet('1850000000000000001', 'hoops_demo', '明天勇士主場打湖人') + xTweet('1850000000000000002', 'b', '', '3 回覆') +
      `<article data-testid="tweet"><div data-testid="tweetText">沒有連結</div></article>`;
    const out = P.readPosts(document, 'x.com', NOW).map(({ id, author, text, replies, ageMinutes }) => ({ id, author, text, replies, ageMinutes }));
    expect(out).toEqual([{ id: '1850000000000000001', author: '@hoops_demo', text: '明天勇士主場打湖人', replies: 86, ageMinutes: 120 }]);
  });
  it('留言数的写法：1,234、1.2K、1.5萬', () => {
    expect(P.num('1,234 replies')).toBe(1234);
    expect(P.num('1.2K')).toBe(1200);
    expect(P.num('1.5萬 則回覆')).toBe(15000);
    expect(P.num('')).toBeNull();
  });
});

describe('Threads', () => {
  it('取帖子短码、作者、文字；链接里的字（用户名、时间）不算正文；同一篇只取一次', () => {
    document.body.innerHTML = `
      <div data-pressable-container="true">
        <a href="/@epl_demo"><span dir="auto">epl_demo</span></a>
        <a href="/@epl_demo/post/DAbc123xyz"><time datetime="${new Date(NOW - 30 * 60000).toISOString()}">30分</time></a>
        <div><span dir="auto">週日凌晨利物浦主場打兵工廠！</span></div>
        <div><span dir="auto">誰會贏？</span></div>
        <a href="/@epl_demo/post/DAbc123xyz"><time datetime="${new Date(NOW - 30 * 60000).toISOString()}">30分</time></a>
      </div>
      <a href="/@x/post/NoContainer1"><time datetime="2026-10-29T00:00:00Z"></time></a>`;
    const out = P.readPosts(document, 'www.threads.com', NOW).map(({ id, author, text, ageMinutes }) => ({ id, author, text, ageMinutes }));
    expect(out).toEqual([{ id: 'DAbc123xyz', author: '@epl_demo', text: '週日凌晨利物浦主場打兵工廠！\n誰會贏？', ageMinutes: 30 }]);
  });
  it('别的网站不读', () => {
    document.body.innerHTML = xTweet('1850000000000000001', 'a', 'x');
    expect(P.platformOf('evil.example')).toBeNull();
    expect(P.readPosts(document, 'evil.example', NOW)).toEqual([]);
    expect(P.platformOf('twitter.com')).toBe('x');
    expect(P.platformOf('www.threads.net')).toBe('threads');
  });
});

describe('自动模式要停下的页面（C136）', () => {
  it('登录、验证、太频繁、出错时给出原因；正常页面返回 null', () => {
    document.body.innerHTML = '<div>首頁</div>';
    expect(P.blockedReason(document, { pathname: '/home' })).toBeNull();
    expect(P.blockedReason(document, { pathname: '/i/flow/login' })).toBe('需要登录或验证');
    expect(P.blockedReason(document, { pathname: '/account/access' })).toBe('需要登录或验证');
    document.body.innerHTML = '<div>Rate limit exceeded</div>';
    expect(P.blockedReason(document, { pathname: '/home' })).toBe('平台提示太频繁');
    document.body.innerHTML = '<div>Something went wrong. Try reloading.</div>';
    expect(P.blockedReason(document, { pathname: '/home' })).toBe('平台页面出错');
  });
});

describe('官方回复窗口和插件权限', () => {
  it('X 用 in_reply_to，Threads 用 reply_post_shortcode；文字编码', () => {
    expect(P.replyUrl('x', '185', '你好 & 再見')).toBe('https://x.com/intent/tweet?in_reply_to=185&text=%E4%BD%A0%E5%A5%BD%20%26%20%E5%86%8D%E8%A6%8B');
    expect(P.replyUrl('threads', 'DAbc', 'a')).toBe('https://www.threads.com/intent/post?reply_post_shortcode=DAbc&text=a');
  });
  it('只要侧边栏和本机存储两个权限；内容脚本只在 X、Threads；没有 Cookie、tabs、任意网站的权限', () => {
    const m = JSON.parse(readFileSync(path.join(SITE_DIR, 'copilot/extension/manifest.json'), 'utf8'));
    expect(m.manifest_version).toBe(3);
    expect(m.permissions).toEqual(['sidePanel', 'storage']);
    expect(m.host_permissions).toBeUndefined();
    expect(m.content_scripts[0].matches).toEqual(['https://x.com/*', 'https://twitter.com/*', 'https://www.threads.com/*', 'https://www.threads.net/*']);
    const js = ['content.js', 'sidepanel.js', 'parse.js'].map((f) => readFileSync(path.join(SITE_DIR, 'copilot/extension', f), 'utf8')).join('\n');
    // 不代按按钮、不碰 Cookie、不模拟输入；只有自动模式的 autoStep 会往下滑（C136）
    expect(js).not.toMatch(/\.click\(\)|document\.cookie|dispatchEvent|execCommand|scrollTo\(/);
    const content = readFileSync(path.join(SITE_DIR, 'copilot/extension/content.js'), 'utf8');
    expect(content.match(/scrollBy/g)).toHaveLength(1);
    expect(content.slice(content.indexOf('async function autoStep'), content.indexOf('document.addEventListener'))).toContain('scrollBy');
  });
});
