/**
 * 读取适配器：从页面上已经显示的元素里取帖子（不滚动、不点开、不请求平台接口；agents C133）。
 * 读不到就返回空，不猜。平台改版时只改这里，测试在 site/test/copilot/parse.test.ts。
 * 结果：{ id, author, text, replies, ageMinutes, el }；id 在 X 是帖子编号，在 Threads 是帖子短码。
 */
(function () {
  const num = (s) => {
    const m = String(s || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KkMm萬万]?)/);
    if (!m) return null;
    const mult = { K: 1e3, k: 1e3, M: 1e6, m: 1e6, 萬: 1e4, 万: 1e4 }[m[2]] || 1;
    return Math.round(parseFloat(m[1]) * mult);
  };
  const age = (t, now) => {
    const d = t && Date.parse(t.getAttribute('datetime') || '');
    return d ? Math.max(0, Math.round((now - d) / 60000)) : null;
  };

  function platformOf(host) {
    if (/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return 'x';
    if (/(^|\.)threads\.(com|net)$/.test(host)) return 'threads';
    return null;
  }

  function readX(root, now) {
    const out = [];
    for (const art of root.querySelectorAll('article[data-testid="tweet"]')) {
      const a = [...art.querySelectorAll('a[href*="/status/"]')].find((x) => x.querySelector('time'));
      const m = a && a.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/);
      const textEl = art.querySelector('[data-testid="tweetText"]');
      if (!m || !textEl) continue;
      const text = textEl.textContent.trim();
      if (!text) continue;
      const reply = art.querySelector('[data-testid="reply"]');
      out.push({ id: m[2], author: '@' + m[1], text, replies: num(reply && reply.getAttribute('aria-label')), ageMinutes: age(a.querySelector('time'), now), el: art });
    }
    return out;
  }

  function readThreads(root, now) {
    const out = [];
    const seen = new Set();
    for (const t of root.querySelectorAll('a[href*="/post/"] time')) {
      const a = t.closest('a');
      const m = a.getAttribute('href').match(/\/@([A-Za-z0-9._]{1,30})\/post\/([A-Za-z0-9_-]{5,40})/);
      if (!m || seen.has(m[2])) continue;
      const box = a.closest('[data-pressable-container="true"]');
      if (!box) continue;
      const parts = [...box.querySelectorAll('span[dir="auto"]')].filter((s) => !s.closest('a') && !s.querySelector('span[dir="auto"]')).map((s) => s.textContent.trim()).filter(Boolean);
      const text = parts.join('\n').trim();
      if (!text) continue;
      seen.add(m[2]);
      out.push({ id: m[2], author: '@' + m[1], text, replies: null, ageMinutes: age(t, now), el: box });
    }
    return out;
  }

  /** 官方回复窗口的地址（X Web Intents、Threads Web Intents）；文字已填好，由本人按发送 */
  function replyUrl(platform, id, text) {
    const t = encodeURIComponent(text);
    if (platform === 'x') return `https://x.com/intent/tweet?in_reply_to=${encodeURIComponent(id)}&text=${t}`;
    return `https://www.threads.com/intent/post?reply_post_shortcode=${encodeURIComponent(id)}&text=${t}`;
  }

  function readPosts(doc, host, now) {
    const p = platformOf(host);
    if (p === 'x') return readX(doc, now);
    if (p === 'threads') return readThreads(doc, now);
    return [];
  }

  globalThis.QCParse = { platformOf, readPosts, readX, readThreads, replyUrl, num };
})();
