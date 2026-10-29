/**
 * 侧边栏：收内容脚本送来的帖子 → 中转服务打分 → 标记回帖子下面；点标记 → 写稿 → Amos 选一条点"同意" → 打开官方回复窗口。
 * 令牌只存在这台电脑的 chrome.storage.local（Amos 自己在"设置"里填，不经过对话，agents C21）。
 */
const $ = (id) => document.getElementById(id);
const P_URL = { x: 'X', threads: 'Threads' };
let cfg = { relay: '', token: '', product: 'forecast' };
let cur = null; // { platform, post, score, reasons, tabId, drafts, pick }
const reasons = new Map(); // id -> reasons

function say(text, ok = false) { $('msg').textContent = text; $('msg').classList.toggle('ok', ok); $('msg').dataset.kind = ''; }
function setNote(text, kind) { const n = $('set-msg'); n.textContent = text; n.className = 'msg' + (kind === 'ok' ? ' ok' : kind === 'busy' ? ' busy' : ''); }
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
  if (r.status === 503) { const e = new Error('团队这一分钟忙不过来（Gemini 免费额度每分钟有上限），30 秒后自动继续'); e.busy = true; throw e; }
  if (r.status === 502) { const j = await r.json().catch(() => ({})); throw new Error('团队暂时没回应（Gemini 没有回答' + (j.detail ? '：' + j.detail : '') + '），稍后再试'); }
  if (!r.ok) throw new Error('中转服务出错了（' + r.status + '）');
  return r.json();
}

// ---- 打分：内容脚本送来的帖子先排队，每 10 秒最多送一批（最多 10 条），Gemini 忙时停 30 秒再继续 ----
// （2026-10-29 Amos 测试版：滚动几条就报错——每 3 秒一次超过了 Gemini 免费档每分钟的上限）
const SCORE_EVERY_MS = 10_000;
const pending = []; // { tabId, platform, post }
let pauseUntil = 0;
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'qc-posts' && sender.tab) {
    for (const post of msg.posts) if (!pending.some((p) => p.post.id === post.id)) pending.push({ tabId: sender.tab.id, platform: msg.platform, post });
    pending.splice(0, Math.max(0, pending.length - 40)); // 只留最近看到的 40 条
    return false;
  }
  if (msg && msg.type === 'qc-select' && sender.tab) {
    select({ platform: msg.platform, post: msg.post, score: msg.score, reasons: reasons.get(msg.post.id) || [], tabId: sender.tab.id });
  }
  return false;
});
setInterval(async () => {
  if (!pending.length || Date.now() < pauseUntil || !cfg.relay || !cfg.token) return;
  const first = pending[0];
  const batch = pending.filter((p) => p.tabId === first.tabId && p.platform === first.platform).slice(0, 10);
  for (const b of batch) pending.splice(pending.indexOf(b), 1);
  try {
    const r = await api('/v1/score', { product: cfg.product, platform: first.platform, posts: batch.map((b) => b.post) });
    setStatus(true, '营销团队在线');
    if ($('msg').dataset.kind === 'score') say('');
    for (const it of r.items) reasons.set(it.id, it.reasons);
    chrome.tabs.sendMessage(first.tabId, { type: 'qc-scores', platform: first.platform, items: r.items }).catch(() => {});
  } catch (e) {
    pending.unshift(...batch); // 没打成分的放回去，下次再送
    if (e.busy) pauseUntil = Date.now() + 30_000;
    else pauseUntil = Date.now() + 60_000;
    setStatus(!!e.busy, e.busy ? '营销团队忙，稍等' : '未连接');
    say(e.message);
    $('msg').dataset.kind = 'score';
  }
}, SCORE_EVERY_MS);

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
  // 按下后马上有反馈：按钮变成"正在连接…"并且不能再按；结果写在按钮下面（2026-10-29 Amos：点了没有任何反应）
  const btn = $('save');
  btn.disabled = true;
  btn.textContent = '正在连接…';
  setNote('正在连接中转服务…', 'busy');
  cfg = { relay: $('relay').value.trim(), token: $('token').value.trim(), product: $('product').value };
  await chrome.storage.local.set({ qc: cfg });
  try {
    await api('/v1/today');
    setStatus(true, '营销团队在线');
    btn.textContent = '✓ 已连接';
    setNote('连接成功，设置已保存。去 X 或 Threads 首页往下滑就能用了。', 'ok');
    setTimeout(() => { btn.textContent = '保存并测试连接'; btn.disabled = false; }, 2000);
  } catch (e) {
    setStatus(false, '未连接');
    btn.textContent = '保存并测试连接';
    btn.disabled = false;
    setNote('连接失败：' + e.message, 'err');
  }
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
  if (!cfg.relay || !cfg.token) { switchTab('set'); setNote('第一次使用：填中转服务地址和连接令牌，再点"保存并测试连接"。', 'busy'); return; }
  api('/v1/today').then(() => setStatus(true, '营销团队在线')).catch((e) => say(e.message));
});
