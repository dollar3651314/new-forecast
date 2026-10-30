/**
 * 侧边栏：收内容脚本送来的帖子 → 中转服务打分 → 标记回帖子下面；点标记 → 写稿 → Amos 选一条点"同意" → 打开官方回复窗口。
 * 令牌只存在这台电脑的 chrome.storage.local（Amos 自己在"设置"里填，不经过对话，agents C21）。
 */
const $ = (id) => document.getElementById(id);
const P_URL = { x: 'X', threads: 'Threads' };
let cfg = { relay: '', token: '', product: 'forecast' };
let cur = null; // { platform, post, score, reasons, tabId, drafts, pick }
const reasons = new Map(); // id -> reasons

// ---- 日志（2026-10-29 Amos：能不能弄个类似日志一样的东西，让我可以看到它是否真的在工作）----
const logs = [];
let lastContentLog = 0;
function addLog(text, level = 'info', from = '侧边栏') {
  const t = new Date();
  logs.unshift({ t, text, level, from });
  logs.splice(200);
  const li = document.createElement('li');
  li.className = level;
  const tm = document.createElement('time');
  tm.textContent = t.toTimeString().slice(0, 8);
  li.append(tm, document.createTextNode(`[${from}] ${text}`));
  $('log-list').prepend(li);
  while ($('log-list').children.length > 200) $('log-list').lastChild.remove();
}
const logText = () => logs.slice().reverse().map((l) => `${l.t.toTimeString().slice(0, 8)} [${l.from}] [${l.level}] ${l.text}`).join('\n');
$('log-copy').addEventListener('click', async () => {
  const n = logs.length;
  try { await navigator.clipboard.writeText(logText()); addLog(`日志已复制（${n} 条）`); } catch { addLog('复制失败，请用"下载日志"', 'warn'); }
});
// 下载成 txt 文件（2026-10-30 Amos：复制只看到最新一条；下载的文件可以直接发给团队看）
// 链接本身就是下载按钮：按下时才生成文件（不用程序代按，parse.test.ts 有检查）
$('log-dl').addEventListener('click', (e) => {
  const a = e.currentTarget;
  const n = logs.length;
  const url = URL.createObjectURL(new Blob([logText() + '\n'], { type: 'text/plain;charset=utf-8' }));
  a.href = url;
  a.download = `copilot-log-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  addLog(`日志已下载（${n} 条，按时间从早到晚）`);
});
$('log-clear').addEventListener('click', () => { logs.length = 0; $('log-list').replaceChildren(); });
addLog('侧边栏已打开');
// 15 秒内没有收到任何页面的消息：多半是 X / Threads 页面在装插件之前就打开了
setTimeout(() => { if (!lastContentLog) addLog('还没有收到 X / Threads 页面的消息：请把 X 或 Threads 的页面刷新一次（装或更新插件之前打开的页面不会被扫描）', 'warn'); }, 15_000);
// 每分钟问一次页面"还在工作吗"
setInterval(() => { chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => t && chrome.tabs.sendMessage(t.id, { type: 'qc-ping' }).catch(() => {})); }, 60_000);

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
  // 503：每个模型为什么用不了（2026-10-30 Amos：不要只说"团队忙"，要说清楚是哪个模型、什么原因）
  if (r.status === 503) { const j = await r.json().catch(() => ({})); const e = new Error('AI 暂时都用不了：' + (j.detail || '免费额度用完') + '。30 秒后自动再试'); e.busy = true; throw e; }
  if (r.status === 502) { const j = await r.json().catch(() => ({})); throw new Error('AI 没有回答' + (j.detail ? '：' + j.detail : '') + '。稍后再试'); }
  if (!r.ok) throw new Error('中转服务出错了（' + r.status + '）');
  return r.json();
}

// ---- 打分：内容脚本送来的帖子先排队，每 10 秒最多送一批（最多 5 条；10 条一批 Gemini 会超时），Gemini 忙时停 30 秒再继续 ----
// （2026-10-29 Amos 测试版：滚动几条就报错——每 3 秒一次超过了 Gemini 免费档每分钟的上限）
const SCORE_EVERY_MS = 10_000;
/** 75 分以上自动写稿、存进待回复清单（2026-10-30 Amos：超过 75 分的就应该被抓到；手动滑动和自动模式一样） */
const SAVE_SCORE = 75;
const saveQ = []; // { tabId, platform, post, score }
const saveSeen = new Set(); // 已经处理过的帖子（同一条不重复写稿）
// 手动页的计数（从打开侧边栏算起；2026-10-30 Amos：要看得到抓到了多少条）
const man = { read: new Set(), scored: 0, queued: 0 };
function manView() {
  $('m-read').textContent = man.read.size;
  $('m-scored').textContent = man.scored;
  $('m-queued').textContent = man.queued;
  $('m-state').textContent = `从打开侧边栏算起；排队等打分 ${pending.length} 条，等写稿存清单 ${saveQ.length} 条`;
}
let scoring = false; // 上一批还没回来就不送下一批（Gemini 最长要等 45 秒）
const pending = []; // { tabId, platform, post }
let pauseUntil = 0;
// 每个 Chrome 窗口有自己的侧边栏：只处理本窗口里的 X / Threads 分页（2026-10-30 Amos：想 X 和 Threads 一起跑——两个窗口并排，各开一个侧边栏）
let myWindow = null;
chrome.windows.getCurrent().then((w) => { myWindow = w.id; }).catch(() => {});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.tab && myWindow != null && sender.tab.windowId !== myWindow) return false;
  if (msg && msg.type === 'qc-log' && sender.tab) {
    lastContentLog = Date.now();
    addLog(msg.text, msg.level, msg.platform === 'x' ? 'X 页面' : 'Threads 页面');
    return false;
  }
  if (msg && msg.type === 'qc-auto-hidden') { if (!sender.tab || sender.tab.id === auto.tabId) autoStop('切换了分页或窗口，已停'); return false; }
  if (msg && msg.type === 'qc-posts' && sender.tab) {
    lastContentLog = Date.now();
    if (auto.on) return false;
    addLog(`收到 ${msg.posts.length} 条帖子，排队等打分（每 10 秒送一批）`);
    for (const post of msg.posts) {
      man.read.add(post.id);
      if (!pending.some((p) => p.post.id === post.id)) pending.push({ tabId: sender.tab.id, platform: msg.platform, post });
    }
    pending.splice(0, Math.max(0, pending.length - 40)); // 只留最近看到的 40 条
    manView();
    return false;
  }
  if (msg && msg.type === 'qc-select' && sender.tab) {
    select({ platform: msg.platform, post: msg.post, score: msg.score, reasons: reasons.get(msg.post.id) || [], tabId: sender.tab.id });
  }
  return false;
});
setInterval(async () => {
  if (scoring || Date.now() < pauseUntil || !cfg.relay || !cfg.token) return;
  // 先把 75 分以上的存进清单，再打下一批（一次只做一件事，不挤占 Gemini 的免费额度）
  if (saveQ.length) {
    scoring = true;
    const it = saveQ.shift();
    try {
      if (await saveToList(it)) man.queued += 1;
    } catch (e) {
      if (e.busy) { saveQ.unshift(it); pauseUntil = Date.now() + 30_000; } else saveSeen.delete(it.post.id);
      addLog(`${it.post.author}（${it.score} 分）没存进清单：${e.message}`, e.busy ? 'warn' : 'error');
      say(e.message);
      $('msg').dataset.kind = 'score';
    } finally {
      scoring = false;
      manView();
    }
    return;
  }
  if (!pending.length) return;
  scoring = true;
  const first = pending[0];
  const batch = pending.filter((p) => p.tabId === first.tabId && p.platform === first.platform).slice(0, 5);
  for (const b of batch) pending.splice(pending.indexOf(b), 1);
  try {
    addLog(`送 ${batch.length} 条去打分…`);
    const r = await api('/v1/score', { product: cfg.product, platform: first.platform, posts: batch.map((b) => b.post) });
    const good = r.items.filter((it) => it.score >= 60).length;
    addLog(`打分完成：${r.items.length} 条，其中值得回 ${good} 条（分数：${r.items.map((it) => it.score).join('、')}）`);
    setStatus(true, '营销团队在线');
    if ($('msg').dataset.kind === 'score') say('');
    man.scored += r.items.length;
    for (const it of r.items) reasons.set(it.id, it.reasons);
    chrome.tabs.sendMessage(first.tabId, { type: 'qc-scores', platform: first.platform, items: r.items }).catch(() => {});
    for (const it of r.items.filter((x) => x.score >= SAVE_SCORE && !saveSeen.has(x.id))) {
      const b = batch.find((x) => x.post.id === it.id);
      if (!b) continue;
      saveSeen.add(it.id);
      saveQ.push({ tabId: b.tabId, platform: b.platform, post: b.post, score: it.score });
      addLog(`${b.post.author} ${it.score} 分（≥ ${SAVE_SCORE}），排队写稿存进清单`);
    }
  } catch (e) {
    pending.unshift(...batch); // 没打成分的放回去，下次再送
    if (e.busy) pauseUntil = Date.now() + 30_000;
    else pauseUntil = Date.now() + 60_000;
    setStatus(!!e.busy, e.busy ? '营销团队忙，稍等' : '未连接');
    addLog('打分失败：' + e.message, e.busy ? 'warn' : 'error');
    say(e.message);
    $('msg').dataset.kind = 'score';
  } finally {
    scoring = false;
    manView();
  }
}, SCORE_EVERY_MS);

/** 写稿 → 第一条通过检查的草稿存进待回复清单 → 页面标记"已存进清单"；没有能用的草稿就记一笔 */
async function saveToList({ tabId, platform, post, score }) {
  const d = await api('/v1/draft', { product: cfg.product, platform, post });
  if (!d.drafts.length) {
    // 页面上的标记保持能点，Amos 可以点开换一批（2026-10-30）
    addLog(`${post.author}（${score} 分）没有能用的草稿（都没通过检查），没存；可以点帖子旁的标记手动换一批`, 'warn');
    return false;
  }
  const q = await api('/v1/queue', { product: cfg.product, platform, post, score, draft: d.drafts[0].text, source: d.drafts[0].source || '', engine: d.drafts[0].engine || 'gemini' });
  chrome.tabs.sendMessage(tabId, { type: 'qc-done', id: post.id, text: '副驾驶：已存进清单' }).catch(() => {});
  addLog(`${post.author}（${score} 分）${q.saved ? '已存进待回复清单' : '清单里已经有了'}${d.drafts[0].engine === 'workers-ai' ? '（备用 AI 写的）' : ''}`);
  return q.saved;
}

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
  $('save-q').disabled = true;
  $('checks').hidden = true;
  say('');
  try {
    addLog(`为 ${cur.post.author} 的帖子写草稿…`);
    const r = await api('/v1/draft', { product: cfg.product, platform: cur.platform, post: cur.post });
    addLog(`草稿：通过检查 ${r.drafts.length} 条，拿掉 ${r.dropped} 条${r.engine === 'workers-ai' ? '（备用 AI 写的）' : ''}`);
    cur.drafts = r.drafts;
    cur.pick = 0;
    renderDrafts(r.dropped);
  } catch (e) {
    $('drafts').replaceChildren();
    say(e.message);
    addLog('写草稿失败：' + e.message, 'error');
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
    if (d.engine === 'workers-ai') el.append(Object.assign(document.createElement('div'), { className: 'src', textContent: '备用 AI 写的（Gemini 当时用不了），发之前多看一眼' }));
    const choose = () => { cur.pick = i; renderDrafts(dropped); };
    el.addEventListener('click', choose);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
    return el;
  }));
  $('checks').hidden = false;
  $('ok').disabled = false;
  $('save-q').disabled = false;
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
$('save-q').addEventListener('click', async () => {
  const d = cur && cur.drafts[cur.pick];
  if (!d) return;
  const b = $('save-q');
  b.disabled = true;
  b.textContent = '正在存…';
  try {
    const r = await api('/v1/queue', { product: cfg.product, platform: cur.platform, post: cur.post, score: cur.score, draft: d.text, source: d.source || '', engine: d.engine || 'gemini' });
    say(r.saved ? '已存进待回复清单，在后台点"一键回复"就行。' : '这条之前已经在清单里了。', true);
    addLog(`存进清单：${cur.post.author}`);
    chrome.tabs.sendMessage(cur.tabId, { type: 'qc-done', id: cur.post.id, text: '副驾驶：已存进清单' }).catch(() => {});
    b.textContent = '存进待回复清单（晚点再回）';
    done();
  } catch (e) {
    say('没存进去：' + e.message);
    b.disabled = false;
    b.textContent = '存进待回复清单（晚点再回）';
  }
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
    // 插件"同意"和后台"我回了"都算回了（2026-10-30：在后台回了 2 条，"今天"却是空的）
    const ACT = { approve: '同意', done: '我回了', skip: '跳过', saved: '进清单' };
    $('today-sum').textContent = `${r.day}：进清单 ${r.saved} 条，已回 ${r.approved} 条（上限 ${r.cap}），跳过 ${r.skipped} 条`;
    $('today-rows').replaceChildren(...r.items.map((x) => {
      const tr = document.createElement('tr');
      const t = new Date(x.at + 8 * 3600e3).toISOString().slice(11, 16);
      for (const v of [t, `${P_URL[x.platform] || x.platform} ${x.author || ''}${x.score != null ? ' · ' + x.score + ' 分' : ''}`, ACT[x.action] || x.action]) tr.append(Object.assign(document.createElement('td'), { textContent: v }));
      return tr;
    }));
    if (!r.items.length) $('today-rows').append(Object.assign(document.createElement('tr'), { innerHTML: '<td colspan="3" class="muted">今天还没有记录</td>' }));
    $('copy').onclick = async () => {
      const lines = [`副驾驶 ${r.day}：进清单 ${r.saved} 条、已回 ${r.approved} 条、跳过 ${r.skipped} 条`, ...r.items.filter((x) => x.action === 'approve' || x.action === 'done').map((x) => `- ${P_URL[x.platform]} ${x.author}（${x.score ?? '–'} 分）：${x.draft}`)];
      try { await navigator.clipboard.writeText(lines.join('\n')); say('已复制，贴到对话里就行。', true); } catch { say('复制失败，请手动选取'); }
    };
  } catch (e) { $('today-sum').textContent = e.message; }
}

// ---- 自动模式（agents C136；状态清单第三节）：侧边栏一步一步驱动页面，每批分析完才滑下一屏 ----
const AUTO_MAX_MS = 30 * 60_000;
const AUTO_MAX_POSTS = 60;
const auto = { on: false, tabId: null, platform: null, started: 0, read: 0, scored: 0, queued: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function autoView(state, kind) {
  $('auto-state').textContent = state;
  $('auto-state').className = 'pill ' + kind;
  $('auto-toggle').setAttribute('aria-checked', String(auto.on));
  $('k-read').textContent = auto.read;
  $('k-scored').textContent = auto.scored;
  $('k-queued').textContent = auto.queued;
}
function autoMsg(t, ok) { $('auto-msg').textContent = t; $('auto-msg').classList.toggle('ok', !!ok); }
function autoStop(reason) {
  if (!auto.on) return;
  auto.on = false;
  if (auto.tabId) chrome.tabs.sendMessage(auto.tabId, { type: 'qc-auto-off' }).catch(() => {});
  autoView('已停', 'stop');
  autoMsg(reason);
  addLog('自动模式停止：' + reason, 'warn');
}
/** Gemini 忙（503）时等 30 秒再试，最多 3 次；其他错误抛出去让自动模式停下 */
async function withBusy(fn) {
  for (let i = 0; ; i++) {
    try { const r = await fn(); if (i) autoMsg(''); return r; } catch (e) {
      if (!e.busy || i >= 2 || !auto.on) throw e;
      autoView('AI 暂时用不了，30 秒后继续', 'wait');
      autoMsg(e.message);
      addLog(e.message, 'warn');
      await sleep(30_000);
    }
  }
}
async function autoStart() {
  auto.on = false;
  $('auto-toggle').setAttribute('aria-checked', 'true');
  autoView('启动中…', 'wait');
  autoMsg('');
  const fail = (t) => { auto.on = false; autoView('已停', 'stop'); autoMsg(t); addLog('自动模式没启动：' + t, 'warn'); };
  if (!cfg.relay || !cfg.token) return fail('先到"设置"填中转服务地址和连接令牌');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let chk = null;
  try { chk = tab ? await chrome.tabs.sendMessage(tab.id, { type: 'qc-auto-check' }) : null; } catch { chk = null; }
  if (!chk || !chk.ok) return fail('当前分页不是 X / Threads，或者页面是装插件之前打开的：请切到 X 首页，刷新一次再开');
  if (chk.blocked) return fail('页面上有"' + chk.blocked + '"的提示，请先看一眼页面');
  try { await api('/v1/today'); } catch (e) { return fail(e.message); }
  Object.assign(auto, { on: true, tabId: tab.id, platform: chk.platform, started: Date.now(), read: 0, scored: 0, queued: 0 });
  chrome.tabs.sendMessage(tab.id, { type: 'qc-auto-on' }).catch(() => {});
  addLog('自动模式开始（' + (chk.platform === 'x' ? 'X' : 'Threads') + '）');
  autoLoop().catch((e) => autoStop('出错了：' + e.message));
}
async function autoLoop() {
  while (auto.on) {
    if (Date.now() - auto.started >= AUTO_MAX_MS) return autoStop('本次已到上限：30 分钟');
    if (auto.read >= AUTO_MAX_POSTS) return autoStop('本次已到上限：60 条');
    autoView('滑动中', 'run');
    let step;
    try { step = await chrome.tabs.sendMessage(auto.tabId, { type: 'qc-auto-step' }); } catch { return autoStop('页面没有回应（可能关掉或刷新了）'); }
    if (!auto.on) return;
    if (!step || step.hidden) return autoStop('切换了分页或窗口，已停');
    if (step.blocked) return autoStop('已停：' + step.blocked + '，请看一眼页面');
    const posts = step.posts.slice(0, AUTO_MAX_POSTS - auto.read);
    auto.read += posts.length;
    autoView('等打分结果', 'wait');
    addLog(`自动：这一屏读到 ${posts.length} 条`);
    for (let i = 0; i < posts.length && auto.on; i += 5) {
      const batch = posts.slice(i, i + 5);
      let r;
      try { r = await withBusy(() => api('/v1/score', { product: cfg.product, platform: auto.platform, posts: batch })); } catch (e) { return autoStop('AI 出错：' + e.message); }
      auto.scored += r.items.length;
      autoView('等打分结果', 'wait');
      chrome.tabs.sendMessage(auto.tabId, { type: 'qc-scores', platform: auto.platform, items: r.items }).catch(() => {});
      addLog(`自动：打分 ${r.items.map((x) => x.score).join('、')}${r.engine === 'workers-ai' ? '（备用 AI）' : ''}`);
      for (const it of r.items.filter((x) => x.score >= SAVE_SCORE && !saveSeen.has(x.id))) {
        if (!auto.on) return;
        const post = batch.find((p) => p.id === it.id);
        if (!post) continue;
        saveSeen.add(it.id);
        try {
          if (await withBusy(() => saveToList({ tabId: auto.tabId, platform: auto.platform, post, score: it.score }))) auto.queued += 1;
          autoView('等打分结果', 'wait');
        } catch (e) { saveSeen.delete(it.id); return autoStop('AI 出错：' + e.message); }
      }
    }
    if (step.end && posts.length === 0) return autoStop('页面到底了');
    await sleep(800);
  }
}
$('auto-toggle').addEventListener('click', () => { if (auto.on) autoStop('你关掉了自动模式'); else autoStart(); });

// ---- 设置 ----
$('save').addEventListener('click', async () => {
  // 按下后马上有反馈：按钮变成"正在连接…"并且不能再按；结果写在按钮下面（2026-10-29 Amos：点了没有任何反应）
  const btn = $('save');
  btn.disabled = true;
  btn.textContent = '正在连接…';
  setNote('正在连接中转服务…', 'busy');
  cfg = { relay: $('relay').value.trim(), token: $('token').value.trim(), product: $('product').value };
  await chrome.storage.local.set({ qc: cfg });
  queueLink();
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

// 测试 AI（2026-10-30：一直超时 / 忙，看不出是哪个模型的问题）：每个模型的状态和用时
$('diag').addEventListener('click', async () => {
  const b = $('diag');
  b.disabled = true;
  b.textContent = '正在测试…（最多约 1 分钟）';
  $('diag-list').replaceChildren();
  try {
    const r = await api('/v1/diag');
    $('diag-list').replaceChildren(...r.models.map((m) => {
      const li = document.createElement('li');
      li.className = m.ok ? '' : 'error';
      li.textContent = `${m.ok ? '✓' : '✗'} ${m.model}：${(m.ms / 1000).toFixed(1)} 秒，${m.detail}`;
      return li;
    }));
    addLog('测试 AI：' + r.models.map((m) => `${m.model} ${m.detail} ${(m.ms / 1000).toFixed(1)}s`).join('；'));
  } catch (e) {
    $('diag-list').replaceChildren(Object.assign(document.createElement('li'), { className: 'error', textContent: '测试失败：' + e.message }));
  } finally {
    b.disabled = false;
    b.textContent = '测试 AI（每个模型发一个很小的请求）';
  }
});

function switchTab(k) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === k)));
  for (const x of ['auto', 'now', 'today', 'log', 'set']) $('tab-' + x).hidden = x !== k;
  if (k === 'today') loadToday();
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function queueLink() { $('open-queue').href = cfg.relay ? cfg.relay.replace(/\/+$/, '') + '/' : '#'; }
chrome.storage.local.get('qc').then(({ qc }) => {
  if (qc) cfg = { ...cfg, ...qc };
  queueLink();
  $('relay').value = cfg.relay;
  $('token').value = cfg.token;
  $('product').value = cfg.product;
  if (!cfg.relay || !cfg.token) { switchTab('set'); setNote('第一次使用：填中转服务地址和连接令牌，再点"保存并测试连接"。', 'busy'); return; }
  api('/v1/today').then(() => setStatus(true, '营销团队在线')).catch((e) => say(e.message));
});
