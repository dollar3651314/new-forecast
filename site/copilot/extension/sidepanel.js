/**
 * 侧边栏：收内容脚本送来的帖子 → 中转服务打分 → 标记回帖子下面；点标记 → 写稿 → Amos 选一条点"同意" → 打开官方回复窗口。
 * 令牌只存在这台电脑的 chrome.storage.local（Amos 自己在"设置"里填，不经过对话，agents C21）。
 */
const $ = (id) => document.getElementById(id);
const P_URL = { x: 'X', threads: 'Threads' };
let cfg = { relay: '', token: '', product: 'forecast' };
let cur = null; // { platform, post, score, reasons, tabId, drafts, pick }
const reasons = new Map(); // id -> reasons

function say(text, ok = false) { $('msg').textContent = text; $('msg').classList.toggle('ok', ok); }
function setStatus(on, text) { $('status').textContent = text; $('status').classList.toggle('on', on); }

async function api(path, body) {
  if (!cfg.relay || !cfg.token) throw new Error('先到"设置"填中转服务地址和连接令牌');
  const r = await fetch(cfg.relay.replace(/\/+$/, '') + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new Error('连接令牌不对，请到"设置"重新填');
  if (r.status === 404) throw new Error('中转服务还没开通（地址不对，或者 Cloudflare 里还没填令牌和 Gemini Key）');
  if (r.status === 429) { const j = await r.json().catch(() => ({})); throw new Error(j.error === 'daily cap' ? `今天已经回了 ${j.cap} 条，到上限了` : '太频繁了，等一分钟再试'); }
  if (r.status === 502) throw new Error('团队暂时没回应（Gemini 没有回答），稍后再试');
  if (!r.ok) throw new Error('中转服务出错了（' + r.status + '）');
  return r.json();
}

// ---- 打分：内容脚本送来的帖子 ----
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'qc-posts' && sender.tab) {
    api('/v1/score', { product: cfg.product, platform: msg.platform, posts: msg.posts })
      .then((r) => {
        setStatus(true, '营销团队在线');
        for (const it of r.items) reasons.set(it.id, it.reasons);
        chrome.tabs.sendMessage(sender.tab.id, { type: 'qc-scores', platform: msg.platform, items: r.items }).catch(() => {});
      })
      .catch((e) => { setStatus(false, '未连接'); say(e.message); });
    return false;
  }
  if (msg && msg.type === 'qc-select' && sender.tab) {
    select({ platform: msg.platform, post: msg.post, score: msg.score, reasons: reasons.get(msg.post.id) || [], tabId: sender.tab.id });
  }
  return false;
});

// ---- 这条 ----
async function select(c) {
  cur = { ...c, drafts: [], pick: 0 };
  switchTab('now');
  $('empty').hidden = true;
  $('cur').hidden = false;
  $('cur-author').textContent = `${P_URL[c.platform]} · ${c.post.author}`;
  $('cur-text').textContent = c.post.text;
  $('cur-score').textContent = c.score ?? '–';
  $('cur-bar').style.width = (c.score || 0) + '%';
  $('cur-why').replaceChildren(...c.reasons.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  await loadDrafts();
}

async function loadDrafts() {
  $('drafts').replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: '团队在写回复…' }));
  $('ok').disabled = true;
  $('checks').hidden = true;
  say('');
  try {
    const r = await api('/v1/draft', { product: cfg.product, platform: cur.platform, post: cur.post });
    cur.drafts = r.drafts;
    cur.pick = 0;
    renderDrafts(r.dropped);
  } catch (e) {
    $('drafts').replaceChildren();
    say(e.message);
  }
}

function renderDrafts(dropped) {
  if (!cur.drafts.length) {
    $('drafts').replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: '这条没有能用的草稿（都没通过检查）。可以点"换一批"或"跳过"。' }));
    return;
  }
  $('drafts').replaceChildren(...cur.drafts.map((d, i) => {
    const el = document.createElement('div');
    el.className = 'draft';
    el.setAttribute('role', 'radio');
    el.tabIndex = 0;
    el.setAttribute('aria-checked', String(i === cur.pick));
    const h = document.createElement('div');
    h.className = 'h';
    h.append(Object.assign(document.createElement('span'), { textContent: d.tone }), Object.assign(document.createElement('span'), { textContent: [...d.text].length + ' 字' }));
    el.append(h, Object.assign(document.createElement('p'), { textContent: d.text }));
    if (d.source) el.append(Object.assign(document.createElement('div'), { className: 'src', textContent: '数据来源：' + d.source }));
    const choose = () => { cur.pick = i; renderDrafts(dropped); };
    el.addEventListener('click', choose);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
    return el;
  }));
  $('checks').hidden = false;
  $('ok').disabled = false;
  if (dropped) say(`另外有 ${dropped} 条草稿没通过检查，已拿掉。`, true);
}

$('ok').addEventListener('click', async () => {
  const d = cur && cur.drafts[cur.pick];
  if (!d) return;
  try {
    await api('/v1/log', { product: cfg.product, platform: cur.platform, postId: cur.post.id, author: cur.post.author, score: cur.score, action: 'approve', draft: d.text });
  } catch (e) { say(e.message); return; }
  // 官方回复窗口（文字已填好），由 Amos 本人按发送
  chrome.windows.create({ url: QCParse.replyUrl(cur.platform, cur.post.id, d.text), type: 'popup', width: 620, height: 720 });
  chrome.tabs.sendMessage(cur.tabId, { type: 'qc-done', id: cur.post.id, text: '副驾驶：已打开回复窗口' }).catch(() => {});
  say('已打开回复窗口，看一眼没问题就按"回复"。', true);
  done();
});
$('again').addEventListener('click', async () => {
  if (!cur) return;
  api('/v1/log', { product: cfg.product, platform: cur.platform, postId: cur.post.id, action: 'regenerate' }).catch(() => {});
  await loadDrafts();
});
$('skip').addEventListener('click', () => {
  if (!cur) return;
  api('/v1/log', { product: cfg.product, platform: cur.platform, postId: cur.post.id, author: cur.post.author, score: cur.score, action: 'skip' }).catch(() => {});
  chrome.tabs.sendMessage(cur.tabId, { type: 'qc-done', id: cur.post.id, text: '副驾驶：已跳过' }).catch(() => {});
  done();
});
function done() { cur = null; $('cur').hidden = true; $('empty').hidden = false; }

// ---- 今天 ----
async function loadToday() {
  try {
    const r = await api('/v1/today');
    $('today-sum').textContent = `${r.day}：已同意 ${r.approved} 条（上限 ${r.cap}），跳过 ${r.skipped} 条`;
    $('today-rows').replaceChildren(...r.items.map((x) => {
      const tr = document.createElement('tr');
      const t = new Date(x.at + 8 * 3600e3).toISOString().slice(11, 16);
      for (const v of [t, `${P_URL[x.platform] || x.platform} ${x.author || ''}`, x.action === 'approve' ? '同意' : '跳过']) tr.append(Object.assign(document.createElement('td'), { textContent: v }));
      return tr;
    }));
    $('copy').onclick = async () => {
      const lines = [`副驾驶 ${r.day}：同意 ${r.approved} 条、跳过 ${r.skipped} 条`, ...r.items.filter((x) => x.action === 'approve').map((x) => `- ${P_URL[x.platform]} ${x.author}（${x.score ?? '–'} 分）：${x.draft}`)];
      try { await navigator.clipboard.writeText(lines.join('\n')); say('已复制，贴到对话里就行。', true); } catch { say('复制失败，请手动选取'); }
    };
  } catch (e) { $('today-sum').textContent = e.message; }
}

// ---- 设置 ----
$('save').addEventListener('click', async () => {
  cfg = { relay: $('relay').value.trim(), token: $('token').value.trim(), product: $('product').value };
  await chrome.storage.local.set({ qc: cfg });
  try { await api('/v1/today'); setStatus(true, '营销团队在线'); say('连接成功。', true); } catch (e) { setStatus(false, '未连接'); say(e.message); }
});

function switchTab(k) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
  for (const x of ['now', 'today', 'set']) $('tab-' + x).hidden = x !== k;
  if (k === 'today') loadToday();
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

chrome.storage.local.get('qc').then(({ qc }) => {
  if (qc) cfg = { ...cfg, ...qc };
  $('relay').value = cfg.relay;
  $('token').value = cfg.token;
  $('product').value = cfg.product;
  if (!cfg.relay || !cfg.token) { switchTab('set'); say('第一次使用：填中转服务地址和连接令牌。'); return; }
  api('/v1/today').then(() => setStatus(true, '营销团队在线')).catch((e) => say(e.message));
});
