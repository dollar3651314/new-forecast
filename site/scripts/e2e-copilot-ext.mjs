#!/usr/bin/env node
/**
 * 副驾驶插件侧边栏的浏览器级自动测试（agents C141）：用替身 chrome API 和替身中转服务，在真浏览器里跑状态清单的主要路径。
 *   node scripts/e2e-copilot-ext.mjs
 * 覆盖：设置填错的提示和保存（C140）；存满 N 条就停；连续读不到新帖且页面看不见 → 暂停、读到新帖继续、到底了停；
 * 在本窗口切分页 → 停、别的窗口切分页不影响；停了以后状态保持"已停"。任何一条不符就以非 0 退出。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const PANEL = pathToFileURL(path.join(here, '../copilot/extension/sidepanel.html')).href;
const fails = [];
const check = (name, ok, got) => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '：实际 ' + JSON.stringify(got)}`); if (!ok) fails.push(name); };

/** 替身：steps 是自动模式每一步页面交回的结果；score 是每条帖子的分数 */
function stub({ steps, score }) {
  return `(() => {
    const store = { qc: { relay: 'http://relay.test', token: 't', product: 'forecast' } };
    const steps = ${JSON.stringify(steps)};
    window.__activated = [];
    window.chrome = {
      storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} },
      tabs: {
        query: async () => [{ id: 7 }],
        sendMessage: async (_t, m) => m.type === 'qc-auto-check' ? { ok: true, platform: 'x' } : m.type === 'qc-auto-step' ? (steps.shift() || { posts: [], end: true }) : undefined,
        onActivated: { addListener: (f) => window.__activated.push(f) }, onRemoved: { addListener() {} },
      },
      windows: { getCurrent: async () => ({ id: 1 }) },
    };
    window.fetch = async (u, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      const s = String(u);
      const j = s.includes('/v1/score') ? { items: body.posts.map((x) => ({ id: x.id, score: ${score}, reasons: ['替身'] })) }
        : s.includes('/v1/draft') ? { drafts: [{ text: '草稿', source: '', engine: 'gemini' }], dropped: 0 }
        : s.includes('/v1/queue') ? { saved: true }
        : { day: 'd', cap: 10, approved: 0, skipped: 0, saved: 0, items: [] };
      return new Response(JSON.stringify(j));
    };
  })()`;
}
const P = (id) => ({ id: String(id), author: '@a', text: 't' + id });

const browser = await chromium.launch();
async function panel(opts) {
  const page = await (await browser.newContext({ viewport: { width: 380, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(stub(opts));
  await page.goto(PANEL);
  await page.waitForTimeout(300);
  return { page, errors };
}
const autoState = (page) => page.evaluate(() => ({ state: document.getElementById('auto-state').textContent, msg: document.getElementById('auto-msg').textContent, queued: document.getElementById('k-queued').textContent, read: document.getElementById('k-read').textContent }));
async function waitFor(page, fn, ms) { const t = Date.now(); for (;;) { const v = await autoState(page); if (fn(v) || Date.now() - t > ms) return v; await page.waitForTimeout(250); } }

try {
  // 1. 设置：填错不保存、红字；填对保存、自动页跟着变
  {
    const { page, errors } = await panel({ steps: [], score: 10 });
    await page.click('[data-tab="set"]');
    await page.fill('#lim-min', '40');
    await page.fill('#lim-queue', '0');
    await page.click('#lim-save');
    const bad = await page.textContent('#lim-msg');
    check('设置填错：红字说明范围、不保存', bad.startsWith('没保存：') && bad.includes('5～30') && bad.includes('1～50'), bad);
    await page.fill('#lim-min', '20');
    await page.fill('#lim-queue', '3');
    await page.fill('#lim-score', '80');
    await page.click('#lim-save');
    await page.waitForTimeout(300);
    const ok = await page.textContent('#lim-msg');
    check('设置填对：已保存、只对这个窗口生效', ok.includes('已保存：20 分钟 / 存满 3 条 / 80 分以上') && ok.includes('只对这个窗口生效'), ok);
    check('自动页显示新上限', (await page.textContent('#auto-limit')).includes('20 分钟，或存满 3 条'), await page.textContent('#auto-limit'));
    check('没有脚本错误（设置）', errors.length === 0, errors);
  }
  // 2. 存满 N 条就停
  {
    const steps = Array.from({ length: 10 }, (_, i) => ({ posts: [P(2 * i + 1), P(2 * i + 2)] }));
    const { page, errors } = await panel({ steps, score: 90 });
    await page.click('[data-tab="set"]');
    await page.fill('#lim-queue', '3');
    await page.click('#lim-save');
    await page.click('[data-tab="auto"]');
    await page.click('#auto-toggle');
    const v = await waitFor(page, (s) => s.state === '已停' && s.msg !== '', 20000);
    check('存满 3 条就停', v.msg === '本次已存满 3 条清单' && v.queued === '3', v);
    check('没有脚本错误（存满）', errors.length === 0, errors);
  }
  // 3. 暂停、继续、到底了；停了以后状态保持"已停"
  {
    const hidden = { posts: [], hidden: true };
    const steps = [{ posts: [P(1)] }, hidden, hidden, hidden, hidden, { posts: [P(2)] }, { posts: [], end: true }, { posts: [], end: true }, { posts: [], end: true }];
    const { page, errors } = await panel({ steps, score: 10 });
    await page.click('[data-tab="auto"]');
    await page.click('#auto-toggle');
    const paused = await waitFor(page, (s) => s.state === '暂停中', 10000);
    check('连续 3 屏没新帖、页面看不见 → 暂停中', paused.state === '暂停中' && paused.msg.startsWith('暂停中：'), paused);
    const end = await waitFor(page, (s) => s.state === '已停' && s.msg !== '', 40000);
    check('读到新帖后继续，最后"页面到底了"', end.msg === '页面到底了' && end.read === '2', end);
    await page.waitForTimeout(1500);
    check('停了以后状态保持"已停"', (await autoState(page)).state === '已停', await autoState(page));
    check('没有脚本错误（暂停）', errors.length === 0, errors);
  }
  // 4. 切分页：本窗口切 → 停；别的窗口切 → 不影响
  {
    const steps = Array.from({ length: 50 }, (_, i) => ({ posts: [P(i + 1)] }));
    const { page, errors } = await panel({ steps, score: 10 });
    await page.click('[data-tab="auto"]');
    await page.click('#auto-toggle');
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__activated.forEach((f) => f({ tabId: 99, windowId: 2 })));
    await page.waitForTimeout(500);
    check('别的窗口切分页不影响', (await autoState(page)).state !== '已停', await autoState(page));
    await page.evaluate(() => window.__activated.forEach((f) => f({ tabId: 99, windowId: 1 })));
    const v = await waitFor(page, (s) => s.state === '已停', 3000);
    check('本窗口切分页 → 停', v.msg === '切到了别的分页，已停', v);
    check('没有脚本错误（切分页）', errors.length === 0, errors);
  }
} finally {
  await browser.close();
}
if (fails.length) { console.error(`\n✗ 副驾驶插件测试有 ${fails.length} 项不通过`); process.exit(1); }
console.log('\n✓ 副驾驶插件测试全部通过');
