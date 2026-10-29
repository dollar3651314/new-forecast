/**
 * 内容脚本：只看屏幕上出现过的帖子（IntersectionObserver），每 3 秒把新出现的（最多 10 条）交给侧边栏打分；
 * 在帖子下面加一个小标记。不滚动、不点开、不改输入框、不代按任何按钮（agents C133）。
 */
(function () {
  const P = globalThis.QCParse;
  const platform = P.platformOf(location.hostname);
  if (!platform) return;
  const known = new Map(); // id -> { post, badge }
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
    for (const p of P.readPosts(document, location.hostname, Date.now())) {
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
    if (msg && msg.type === 'qc-scores' && msg.platform === platform) for (const it of msg.items) badge(it.id, it.score);
    if (msg && msg.type === 'qc-done' && known.has(msg.id)) {
      const b = known.get(msg.id).el.querySelector(':scope .qc-badge');
      if (b) { b.textContent = msg.text; b.disabled = true; b.classList.add('qc-low'); }
    }
  });

  setInterval(() => {
    scan();
    if (!queue.length) return;
    const batch = queue.splice(0, 10);
    chrome.runtime.sendMessage({ type: 'qc-posts', platform, posts: batch }).catch(() => {
      // 侧边栏没打开：放回去，最多留 30 条，打开侧边栏后再送
      queue.unshift(...batch);
      queue.splice(30);
    });
  }, 3000);
})();
