/**
 * 内容脚本：只看屏幕上出现过的帖子（IntersectionObserver），每 3 秒把新出现的（最多 10 条）交给侧边栏打分；
 * 在帖子下面加一个小标记。不滚动、不点开、不改输入框、不代按任何按钮（agents C133）。
 */
(function () {
  const P = globalThis.QCParse;
  const platform = P.platformOf(location.hostname);
  if (!platform) return;
  const known = new Map(); // id -> { post, badge }
  // 日志：送给侧边栏的"日志"页（侧边栏没开就丢掉），让 Amos 看到插件在不在工作（2026-10-29 Amos 要求）
  const log = (text, level = 'info') => chrome.runtime.sendMessage({ type: 'qc-log', platform, level, text }).catch(() => {});
  let lastCount = -1;
  let emptyScans = 0;
  log(`已在 ${platform === 'x' ? 'X' : 'Threads'} 页面启动（${location.pathname}）`);
  const queue = [];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.getAttribute('data-qc-id');
      const k = id && known.get(id);
      if (k && !k.queued) { k.queued = true; queue.push(k.post); }
      io.unobserve(e.target);
    }
  });

  function scan() {
    const found = P.readPosts(document, location.hostname, Date.now());
    if (found.length === 0) {
      emptyScans += 1;
      if (emptyScans === 4) log('这一页上读不到帖子：可能不在首页 / 时间线，或者平台改了页面结构。请截图日志给我们', 'warn');
    } else emptyScans = 0;
    for (const p of found) {
      if (known.has(p.id)) continue;
      p.el.setAttribute('data-qc-id', p.id);
      known.set(p.id, { post: { id: p.id, author: p.author, text: p.text.slice(0, 1000), replies: p.replies, ageMinutes: p.ageMinutes }, el: p.el });
      io.observe(p.el);
    }
  }

  function badge(id, score) {
    const k = known.get(id);
    if (!k || !k.el.isConnected) return;
    let b = k.el.querySelector(':scope .qc-badge');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'qc-badge';
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        chrome.runtime.sendMessage({ type: 'qc-select', platform, post: k.post, score: k.score });
      });
      k.el.appendChild(b);
    }
    k.score = score;
    const good = score >= 60;
    b.classList.toggle('qc-low', !good);
    b.textContent = good ? `副驾驶：值得回 · ${score} 分` : `副驾驶：不建议回 · ${score} 分`;
    b.disabled = !good;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'qc-ping') log(`仍在工作：本页读到 ${known.size} 条，排队 ${queue.length} 条`);
    if (msg && msg.type === 'qc-scores' && msg.platform === platform) for (const it of msg.items) badge(it.id, it.score);
    if (msg && msg.type === 'qc-done' && known.has(msg.id)) {
      const b = known.get(msg.id).el.querySelector(':scope .qc-badge');
      if (b) { b.textContent = msg.text; b.disabled = true; b.classList.add('qc-low'); }
    }
  });

  // ---- 自动模式（agents C136）：侧边栏说"下一步"才滑一屏；滑完读屏幕上的新帖子交回去。不点任何东西 ----
  let autoOn = false;
  const autoSent = new Set();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight;
  }
  async function autoStep() {
    if (document.visibilityState !== 'visible') return { hidden: true };
    const blocked = P.blockedReason(document, location);
    if (blocked) return { blocked };
    const before = scrollY;
    window.scrollBy({ top: Math.round(innerHeight * 0.85), behavior: 'smooth' });
    await sleep(1800); // 等页面把新帖子画出来
    scan();
    const posts = [];
    for (const [id, k] of known) if (!autoSent.has(id) && k.el.isConnected && inView(k.el)) { autoSent.add(id); posts.push(k.post); }
    const end = scrollY <= before + 5;
    return { posts, end, blocked: P.blockedReason(document, location) };
  }
  document.addEventListener('visibilitychange', () => {
    if (autoOn && document.visibilityState !== 'visible') chrome.runtime.sendMessage({ type: 'qc-auto-hidden' }).catch(() => {});
  });
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg) return false;
    if (msg.type === 'qc-auto-check') { reply({ ok: true, platform, blocked: P.blockedReason(document, location) }); return false; }
    if (msg.type === 'qc-auto-on') { autoOn = true; log('自动模式开始'); return false; }
    if (msg.type === 'qc-auto-off') { autoOn = false; log('自动模式已停'); return false; }
    if (msg.type === 'qc-auto-step') { autoStep().then(reply); return true; }
    return false;
  });

  setInterval(() => {
    scan();
    if (autoOn) return; // 自动模式下由侧边栏一步一步要帖子
    if (known.size !== lastCount) {
      lastCount = known.size;
      if (known.size) log(`页面上累计读到 ${known.size} 条帖子，等待送去打分 ${queue.length} 条`);
    }
    if (!queue.length) return;
    const batch = queue.splice(0, 10);
    chrome.runtime.sendMessage({ type: 'qc-posts', platform, posts: batch }).catch(() => {
      // 侧边栏没打开：放回去，最多留 30 条，打开侧边栏后再送
      queue.unshift(...batch);
      queue.splice(30);
    });
  }, 3000);
})();
