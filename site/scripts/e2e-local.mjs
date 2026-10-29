#!/usr/bin/env node
/**
 * 本机端到端（Playwright + wrangler dev），按**真实用户路径**走（v1.1：上次验收失败的原因之一是只测了"功能对"，没测"用户用起来对"）：
 *   首页（1440、390，主按钮在首屏内 C79）→ 留邮箱 → 看到成功状态（✓ 確認信已寄出）→ 从替身邮件里取出 HTML，渲染成截图，点按钮链接
 *   → **直接看到专属页面（不按任何按钮）** → 刷新 → 仍是专属页面 → 朋友用邀请链接订阅 → 专属页面人数 +1
 *   → 链接过期页（把一个待确认订阅者的寄信时间改到 8 天前）→ 重新寄送
 *   → 名单页登录（先输错一次，看提示是通用的）→ 来源显示"订阅者邀请"和邀请人、邀请排行
 *   → 用下拉和日期时间选择器加焦点战、下载 Excel 模板填 2 场再导入（先看预览）→ 首页显示（没有"上線後這裡顯示…"那行字）
 *   → 导出 Excel（先输错密码看提示）并用库读回检查表头和内容 → 在专属页面退订 → 显示已退订 → 旧的 /invite 链接跳到专属页面；
 *   另起一个测试版（--env staging）：公开页面不要密码、有 noindex 和禁止收录的 robots.txt、名单页仍要密码（空库：内测 0 人的说明）。
 * 发信：Resend 用本机替身（RESEND_API_URL 只在 ENVIRONMENT = local 时生效）。行情：本机网络取不到时只记一句，不算失败。
 * 名单页：地址是密钥 ADMIN_PATH（这里每次随机生成一个测试用的），检查 /admin、/console.html、/api/admin/* 和不存在的地址一模一样。
 * 截图：assets/v1.1/site/（仓库是公开的：截图里没有密码——每张截图前检查页面文字和输入框里没有密码；名单页的邮箱是打码的）。
 * 每张截图前自动检查（C50）：页面上没有 NaN / undefined / Invalid Date、没有横向溢出、没有内部编号和英文技术词、没有密码；页面脚本出错最后统一报。
 * 用法：npm run build && node scripts/e2e-local.mjs [--no-screenshots]。每步一行 ✓ / ✗，失败时停下并打印 wrangler 的日志。
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as XLSX from 'xlsx';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(site, '..');
const SHOTS = path.join(repo, 'assets/v1.1/site');
const screenshots = !process.argv.includes('--no-screenshots');
const PORT = Number(process.env.E2E_PORT || 8799);
const STAGING_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const state = mkdtempSync(path.join(tmpdir(), 'qc-e2e-'));
const PASSWORD = randomBytes(18).toString('base64url'); // 每次运行随机，≥ 16 个字符，不打印、不进截图
// 名单页的地址（线上是密钥 ADMIN_PATH）：每次运行随机，测试用
const OPS = `/qc-ops-e2e-${randomBytes(6).toString('hex')}`;
const procs = [];
const logs = {};
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
const shotList = [];

function ok(msg) {
  console.log(`✓ ${msg}`);
}
function note(msg) {
  console.log(`· ${msg}`);
}
async function fail(msg) {
  console.error(`✗ ${msg}`);
  if (typeof pageErrors !== 'undefined' && pageErrors.length) console.error(`页面脚本出错：${pageErrors.join('；')}`);
  for (const [name, buf] of Object.entries(logs)) console.error(`---- ${name} 日志（最后 40 行）----\n${buf.split('\n').slice(-40).join('\n')}`);
  await cleanup();
  process.exit(1);
}
process.on('uncaughtException', (e) => void fail(`脚本出错：${e?.stack || e}`));
process.on('unhandledRejection', (e) => void fail(`脚本出错：${e?.stack || e}`));

/** 等预览出现；出现的是报错时把报错打出来 */
async function waitPreview(page) {
  try {
    await page.locator('[data-testid="imp-preview"], [data-testid="match-import"] [role="alert"]').first().waitFor();
  } catch {
    await fail(`导入没有反应：${await page.getByTestId('match-import').textContent()}`);
  }
  if (!(await page.getByTestId('imp-preview').count())) await fail(`导入没有出预览：${await page.getByTestId('match-import').textContent()}`);
}

async function check(cond, msg) {
  if (!cond) await fail(msg);
}

// ---------- Resend 替身 ----------
const mails = [];
const mailServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      mails.push({ auth: req.headers.authorization, ...JSON.parse(body) });
    } catch {
      /* 忽略 */
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"e2e"}');
  });
});
await new Promise((r) => mailServer.listen(0, '127.0.0.1', r));
const MAIL_URL = `http://127.0.0.1:${mailServer.address().port}/emails`;

async function cleanup() {
  for (const p of procs) {
    try {
      process.kill(-p.pid, 'SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
  mailServer.close();
  rmSync(path.join(site, 'wrangler.e2e.toml'), { force: true });
  rmSync(state, { recursive: true, force: true });
}

async function waitFor(fn, what, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 再试 */
    }
    if (Date.now() > until) return fail(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function startDev(name, port, extra) {
  const p = spawn(
    'npx',
    ['wrangler', 'dev', '-c', 'wrangler.e2e.toml', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', path.join(state, name), '--show-interactive-dev-session=false', ...extra],
    { cwd: site, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  logs[name] = '';
  p.stdout.on('data', (d) => (logs[name] += d));
  p.stderr.on('data', (d) => (logs[name] += d));
  procs.push(p);
  return p;
}

function d1(name, sql) {
  const e = name === 'prod' ? '' : 'staging';
  return execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', e ? 'new-forecast-site-staging' : 'new-forecast-site', '-c', 'wrangler.e2e.toml', '--local', `--env=${e}`, '--persist-to', path.join(state, name), '--command', sql],
    { cwd: site, env, stdio: 'pipe' },
  ).toString();
}

const mailFor = (to, after = 0) => waitFor(() => mails.slice(after).reverse().find((m) => m.to?.[0] === to), `寄给 ${to} 的确认邮件`, 15_000);
const linksOf = (text) => text.match(/http:\/\/localhost:\d+\S+/g) ?? [];

// ---------- 准备 ----------
await check(existsSync(path.join(site, 'dist/index.html')), '没有 site/dist：先运行 npm run build');
// 本机用的配置：和正式版一样（除 /assets/* 外都先进 Worker，wrangler dev --test-scheduled 的 /__scheduled 也就先进 Worker）
const toml = readFileSync(path.join(site, 'wrangler.toml'), 'utf8');
await check(toml.includes('run_worker_first = ["/*", "!/assets/*"]'), '正式版的 run_worker_first 变了，端到端的假设要跟着改');
writeFileSync(path.join(site, 'wrangler.e2e.toml'), toml);
for (const name of ['prod', 'staging']) {
  try {
    execFileSync(
      'npx',
      ['wrangler', 'd1', 'migrations', 'apply', name === 'prod' ? 'new-forecast-site' : 'new-forecast-site-staging', '-c', 'wrangler.e2e.toml', '--local', `--env=${name === 'prod' ? '' : 'staging'}`, '--persist-to', path.join(state, name)],
      { cwd: site, env, stdio: 'pipe' },
    );
  } catch (err) {
    await fail(`本地 D1 迁移失败（${name}）：${String(err.stderr || err).slice(0, 500)}`);
  }
}
ok('本地 D1 迁移（正式版、测试版各一个库，含 0002 主客队两列）');

startDev('prod', PORT, [
  '--env=',
  '--test-scheduled',
  '--var', 'ENVIRONMENT:local',
  '--var', `PUBLIC_BASE_URL:${BASE}`,
  '--var', 'VERSION:e2e-local',
  '--var', 'RESEND_API_KEY:e2e_dummy_key',
  '--var', `RESEND_API_URL:${MAIL_URL}`,
  '--var', `ADMIN_PASSWORD:${PASSWORD}`,
  '--var', `ADMIN_PATH:${OPS}`,
  '--var', 'BACKUP_URL:https://new-forecast-site.example.workers.dev',
]);
const health = await waitFor(async () => (await fetch(`${BASE}/api/health`)).json(), 'wrangler dev 启动', 90_000);
await check(health.status === 'UP' && health.version === 'e2e-local' && health.checks.mail === 'ok' && health.checks.admin === 'ok' && !('gate' in health.checks), `健康检查：${JSON.stringify(health)}`);
await check(!JSON.stringify(health).includes(PASSWORD), '健康检查里出现了密码');
ok('wrangler dev 启动；健康检查 UP、mail ok（替身）、admin ok、没有整站密码门');

for (const p of ['/api/auth/login', '/api/auth/register', '/api/me', '/api/bets', '/api/wallet/deposit-address', '/api/withdraw', '/api/markets', '/api/gate/login', '/api/public/invite']) {
  const s = (await fetch(`${BASE}${p}`, { method: p === '/api/gate/login' ? 'POST' : 'GET' })).status;
  await check(s === 404, `${p} 应该 404，实际 ${s}`);
}
ok('交易、账户类接口和已去掉的接口（整站密码门、旧邀请查看）一律 404');

// 名单页不能被猜到：旧地址、名单页的 HTML 文件都和不存在的地址一模一样
const unknownPage = await fetch(`${BASE}/no-such-page`, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } });
const unknownBody = await unknownPage.text();
for (const p of ['/admin', '/admin/', '/admin.html', '/console', '/console.html']) {
  const r = await fetch(`${BASE}${p}`, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' }, redirect: 'manual' });
  await check(r.status === unknownPage.status && (await r.text()) === unknownBody, `${p} 和不存在的页面不一样（${r.status}）`);
}
const unknownApi = await fetch(`${BASE}/api/no-such-thing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const unknownApiBody = await unknownApi.text();
for (const p of ['/api/admin/login', '/api/admin/session', '/api/admin/export']) {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  await check(r.status === unknownApi.status && (await r.text()) === unknownApiBody, `${p} 和不存在的接口不一样（${r.status}）`);
}
await check((await fetch(`${BASE}${OPS}`)).status === 200, '名单页地址打不开');
ok('名单页：只在 ADMIN_PATH 下；/admin、/admin.html、/console.html、/api/admin/* 和不存在的地址一模一样');

await fetch(`${BASE}/__scheduled?cron=*/5+*+*+*+*`);
const board = await waitFor(async () => {
  const h = await (await fetch(`${BASE}/api/health`)).json();
  return h.checks.board.sources.length >= 1 ? h.checks.board : null;
}, '定时任务跑完', 30_000);
if (board.status === 'ok') ok(`定时任务取到行情：来源 ${board.source}`);
else note(`看板：本机网络取不到行情（${board.sources.map((s) => `${s.source}: ${s.error}`).join('；')}），页面显示"暂时取不到"`);

// ---------- 浏览器 ----------
if (screenshots) {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
}
const browser = await chromium.launch();
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW', acceptDownloads: true });
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', isMobile: true, hasTouch: true, deviceScaleFactor: 2, acceptDownloads: true });
for (const ctx of [desktop, mobile]) ctx.setDefaultTimeout(15_000);
var pageErrors = [];
const watch = (ctx) => ctx.on('page', (p) => {
  p.on('pageerror', (e) => pageErrors.push(`${p.url()}：${e}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(`${p.url()}：console ${m.text()}`);
  });
});
watch(desktop);
watch(mobile);

/** 自动检查（C50）+ 截图。公开页面多查内部编号和英文技术词；任何页面都不能有密码 */
async function shot(page, name, { admin = false } = {}) {
  const r = await page.evaluate(() => ({
    text: document.body.innerText,
    inputs: [...document.querySelectorAll('input')].map((i) => i.value).join('\n'),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  }));
  await check(!/\bNaN\b|undefined|Invalid Date/.test(r.text), `${name}：页面上有 NaN / undefined / Invalid Date`);
  await check(r.overflow <= 0, `${name}：横向溢出 ${r.overflow}px`);
  await check(!r.text.includes(PASSWORD) && !r.inputs.includes(PASSWORD), `${name}：页面上有密码`);
  const banned = /\bM-\d|\bC-\d|JSON|\bsrc\b|\bcmp\b|ADMIN_PASSWORD|qc-waitlist/;
  const m = r.text.replace(/https?:\/\/\S+/g, '').match(banned);
  await check(!m, `${name}：页面上有内部编号或技术词「${m?.[0]}」`);
  if (!admin) await check(!/\binvite\b|\bref\b/.test(r.text.replace(/https?:\/\/\S+/g, '')), `${name}：公开页面上有英文技术词`);
  if (screenshots) {
    // 整页截图前回到顶部：吸顶的测试环境条才不会出现在截图中间
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
    shotList.push(name);
  }
}

// 首页：电脑 1440 两栏、手机 390 单栏、主按钮在首屏内（C79）
const home = await desktop.newPage();
await home.goto(`${BASE}/?src=threads&cmp=e2e`);
await home.getByRole('button', { name: '上線時通知我' }).waitFor();
await check((await home.locator('[data-layout="desktop"]').count()) === 1, '电脑版首页不是两栏');
await home.waitForFunction(() => !document.querySelector('[data-testid="btc-card"]')?.textContent?.includes('讀取中'));
await check((await home.getByTestId('env-banner').textContent()).includes('測試環境'), '本机（local）应该有测试环境标识条');
let box = await home.getByRole('button', { name: '上線時通知我' }).boundingBox();
await check(box && box.y + box.height <= 900, `1440×900 下"上線時通知我"不在首屏内`);
await check((await home.getByRole('checkbox', { name: /我願意參加內測.*（選填）/ }).count()) === 1, '内测勾选没有写"選填"');
await shot(home, '01-首页-1440.png');
const mhome = await mobile.newPage();
await mhome.goto(`${BASE}/?src=x`);
await mhome.getByRole('button', { name: '上線時通知我' }).waitFor();
box = await mhome.getByRole('button', { name: '上線時通知我' }).boundingBox();
await check(box && box.y + box.height <= 844, `390×844 下"上線時通知我"不在首屏内`);
await mhome.waitForFunction(() => !document.querySelector('[data-testid="btc-card"]')?.textContent?.includes('讀取中'));
await shot(mhome, '01-首页-390.png');
ok('首页：电脑两栏、手机单栏，主按钮在首屏内，内测勾选写明"選填"');

// 留邮箱 → 成功状态
const owner = `owner-${Date.now()}@example.com`;
await home.getByLabel('電子信箱').fill(owner);
await home.getByRole('checkbox', { name: /我願意參加內測/ }).check();
await home.getByRole('button', { name: '上線時通知我' }).click();
const done = home.getByTestId('subscribe-done');
await done.waitFor();
await check((await done.textContent()).includes('確認信已寄出') && (await done.textContent()).includes('請到信箱點連結完成訂閱'), `成功状态：${await done.textContent()}`);
await check((await home.getByRole('button', { name: '換一個信箱' }).getAttribute('class')).includes('linkbtn'), '"換一個信箱"不是文字链接');
await shot(home, '02-留邮箱成功-1440.png');
await check((await home.getByTestId('subscribe-done').count()) === 1, '整页截图以后成功状态没了（排版切换时表单状态丢失）');
const mobileUser = `mobile-${Date.now()}@example.com`;
await mhome.getByLabel('電子信箱').fill(mobileUser);
await mhome.getByRole('button', { name: '上線時通知我' }).click();
await mhome.getByTestId('subscribe-done').waitFor();
await shot(mhome, '02-留邮箱成功-390.png');
ok('留邮箱：表单变成"✓ 確認信已寄出，請到信箱點連結完成訂閱"，"換一個信箱"是下面的文字链接');

// 确认邮件：HTML 渲染成截图，点按钮链接
const m1 = await mailFor(owner);
await check(m1.subject.startsWith('[測試環境] 請確認訂閱'), `邮件标题：${m1.subject}`);
await check(typeof m1.html === 'string' && m1.text.includes('BEP20') && m1.html.includes('BEP20'), '确认邮件缺 HTML 版或充值提醒');
const textLinks = linksOf(m1.text);
await check(textLinks.length === 1 && textLinks[0].includes('/subscription?k='), `纯文本邮件里的链接：${textLinks}`);
const pageUrl = textLinks[0];
await check(/^<http:\/\/localhost:\d+\/unsubscribe\?t=[0-9a-f]{32}>$/.test(m1.headers?.['List-Unsubscribe'] ?? ''), '邮件头没有 List-Unsubscribe');
for (const [ctx, w] of [
  [desktop, 1440],
  [mobile, 390],
]) {
  const mp = await ctx.newPage();
  await mp.setContent(m1.html);
  const btn = mp.getByRole('link', { name: '確認訂閱' });
  await check((await btn.getAttribute('href')) === pageUrl, '按钮链接不是专属页面');
  const bg = await btn.evaluate((a) => getComputedStyle(a.closest('td')).backgroundColor);
  await check(bg === 'rgb(45, 212, 191)', `按钮底色不是青绿：${bg}`);
  await check((await mp.locator('a[href]').count()) === 2, '邮件里除了按钮和备用文字链接还有别的链接');
  await shot(mp, `03-确认邮件-${w}.png`);
  if (w === 1440) {
    // 点按钮（邮件里是新窗口打开；这里在同一页打开，方便检查）
    await btn.evaluate((a) => a.removeAttribute('target'));
    await btn.click();
    await mp.waitForURL(/\/subscription\?k=/);
    await mp.getByTestId('sub-ok').waitFor();
    await check(!(await mp.getByRole('button', { name: '確認訂閱' }).count()), '专属页面上还有"確認訂閱"按钮');
    await check((await mp.getByTestId('sub-ok').textContent()).includes('願意參加內測'), '专属页面没提内测');
    await check((await mp.getByTestId('deposit-tip').textContent()).includes('BEP20'), '专属页面没有充值提醒');
    await check(!(await mp.getByText('打開我的專屬頁面').count()), '专属页面还有"打開我的專屬頁面"小字');
    await shot(mp, '04-专属页面-自动确认后-1440.png');
    await mp.reload();
    await mp.getByTestId('sub-ok').waitFor();
    await check((await mp.getByTestId('invite-count').textContent()).includes('0 人'), '刷新后人数不对');
    await shot(mp, '05-专属页面-刷新后-1440.png');
    await mp.close();
  } else await mp.close();
}
const mpage = await mobile.newPage();
await mpage.goto(pageUrl);
await mpage.getByTestId('sub-ok').waitFor();
await shot(mpage, '04-专属页面-自动确认后-390.png');
await mpage.reload();
await mpage.getByTestId('sub-ok').waitFor();
await shot(mpage, '05-专属页面-刷新后-390.png');
const inviteLink = (await mpage.getByTestId('invite-link').textContent()).trim();
const code = new URL(inviteLink).searchParams.get('ref');
await check(/^[2-9A-HJKMNP-Z]{6}$/.test(code), `邀请链接：${inviteLink}`);
ok(`确认邮件：HTML 版有青绿按钮和备用文字链接，只有专属页面一个入口；点按钮直接看到"訂閱成功"（没按任何按钮），刷新后仍是同一页（邀请码 ${code}）`);

// 朋友用邀请链接订阅 → 专属页面人数 +1
const friendCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-TW' });
watch(friendCtx);
const fp = await friendCtx.newPage();
const friend = `friend-${Date.now()}@example.com`;
await fp.goto(inviteLink);
await fp.getByLabel('電子信箱').fill(friend);
await fp.getByRole('button', { name: '上線時通知我' }).click();
await fp.getByTestId('subscribe-done').waitFor();
const m2 = await mailFor(friend);
await fp.goto(linksOf(m2.text)[0]);
await fp.getByTestId('sub-ok').waitFor();
await friendCtx.close();
await mpage.reload();
await mpage.getByTestId('invite-count').waitFor();
await check((await mpage.getByTestId('invite-count').textContent()).includes('1 人'), `专属页面人数：${await mpage.getByTestId('invite-count').textContent()}`);
ok('邀请：朋友用邀请链接留邮箱、打开确认信就完成；本人刷新专属页面显示"你已邀請 1 人"');

// 链接过期：把手机那位（还没确认）的寄信时间改到 8 天前
const m3 = await mailFor(mobileUser);
const expiredUrl = linksOf(m3.text)[0];
const old = new Date(Date.now() - 8 * 86400_000).toISOString();
try {
  d1('prod', `UPDATE subscribers SET confirm_sent_at = '${old}' WHERE email = '${mobileUser}'`);
} catch (err) {
  await fail(`改寄信时间失败：${String(err.stderr || err).slice(0, 300)}`);
}
for (const [ctx, w] of [
  [desktop, 1440],
  [mobile, 390],
]) {
  const ep = await ctx.newPage();
  await ep.goto(expiredUrl);
  await ep.getByTestId('sub-expired').waitFor();
  await shot(ep, `06-链接过期-${w}.png`);
  if (w === 390) {
    const before = mails.length;
    await ep.getByTestId('sub-resend').click();
    await ep.getByText(/已重新寄出/).waitFor();
    const m4 = await mailFor(mobileUser, before);
    await check(linksOf(m4.text)[0] === expiredUrl, '重寄的邮件链接变了');
    await ep.goto(expiredUrl);
    await ep.getByTestId('sub-ok').waitFor();
  }
  await ep.close();
}
ok('链接过期：显示"這個連結已經超過 7 天"和"重新寄送確認信"；重寄后打开同一个链接就完成订阅');

// 旧链接兼容：/invite?k= 跳到专属页面
const legacy = await desktop.newPage();
await legacy.goto(pageUrl.replace('/subscription?', '/invite?'));
await legacy.waitForURL(/\/subscription\?k=/);
await legacy.getByTestId('sub-ok').waitFor();
await legacy.close();
ok('旧的 /invite?k= 链接跳到专属页面');

// ---------- 名单页 ----------
async function adminLogin(page, shotName) {
  await page.goto(`${BASE}${OPS}`);
  await page.getByTestId('admin-login').waitFor();
  await page.getByLabel('密码').fill('wrong-password-for-e2e');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('登录失败，请稍后再试。').waitFor();
  if (shotName) await shot(page, shotName, { admin: true });
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByTestId('kpi-confirmed').waitFor();
}
const adm = await desktop.newPage();
await adm.goto(`${BASE}${OPS}`);
await adm.getByTestId('admin-login').waitFor();
await shot(adm, '07-名单页登录-1440.png', { admin: true });
await adminLogin(adm, '08-名单页输错密码-1440.png');
const madm = await mobile.newPage();
await madm.goto(`${BASE}${OPS}`);
await madm.getByTestId('admin-login').waitFor();
await shot(madm, '07-名单页登录-390.png', { admin: true });
await adminLogin(madm, '08-名单页输错密码-390.png');
const failText = await adm.evaluate(() => document.body.innerText);
await check(!/15 分钟|5 次|锁定/.test(failText), '登录失败提示里有规则');
ok('名单页：输错密码提示"登录失败，请稍后再试。"（不说次数、锁定）；输对后进入');

const cookies = await desktop.cookies();
const sess = cookies.filter((c) => c.name === 'qc_admin');
await check(sess.length === 1 && sess.every((c) => c.httpOnly && c.secure && c.sameSite === 'Strict' && c.path === OPS), '名单页会话 Cookie 属性不对');
await check((await adm.getByTestId('kpi-confirmed').textContent()) === '3', `累计确认：${await adm.getByTestId('kpi-confirmed').textContent()}`);
await check((await adm.getByTestId('kpi-beta').textContent()) === '1', '内测人数不是 1');
const channels = await adm.getByTestId('channels').textContent();
await check(channels.includes('订阅者邀请') && channels.includes('Threads') && channels.includes('X'), `来源表：${channels}`);
await adm.getByTestId('inviter-rows').waitFor();
await check((await adm.getByTestId('inviter-rows').textContent()).includes('o***@example.com1'), '邀请排行不对');
await adm.getByTestId('sub-rows').waitFor();
const rows = await adm.getByTestId('sub-rows').textContent();
await check(!rows.includes(owner) && rows.includes('o***@example.com') && rows.includes('订阅者邀请'), `名单：${rows}`);
await check((await adm.locator('[data-testid="sub-rows"] tr', { hasText: 'f***@example.com' }).textContent()).includes('o***@example.com'), '被邀请的人没有显示邀请人');
await shot(adm, '09-名单页指标名单邀请排行-1440.png', { admin: true });
await madm.getByTestId('sub-rows').waitFor();
await madm.getByTestId('inviter-rows').waitFor();
await shot(madm, '09-名单页指标名单邀请排行-390.png', { admin: true });
ok('名单页：来源显示"订阅者邀请""Threads""X"，被邀请的人有邀请人（打码），邀请排行 o***@example.com 1 人');

// 焦点战：下拉 + 日期时间选择器
const tw = (d) => new Date(Date.now() + d * 86400_000 + 8 * 3600_000).toISOString().slice(0, 10);
await adm.getByTestId('m-save').click();
await adm.getByText(/有 4 处要改/).waitFor();
await adm.getByTestId('m-league').selectOption('NBA');
await adm.getByTestId('m-home').fill('湖人');
await adm.getByTestId('m-away').fill('勇士');
await adm.getByTestId('m-startsAt').fill(`${tw(2)}T09:30`);
await adm.getByTestId('m-save').click();
await adm.getByText('已保存，首页已更新。').waitFor();
await adm.getByTestId('match-rows').getByText('湖人 vs 勇士').waitFor();
await check((await adm.getByTestId('match-rows').textContent()).includes(`${tw(2)} 09:30`), '台湾时间没对上');
// 模板 → 填 2 场 → 导入
const [tplDl] = await Promise.all([adm.waitForEvent('download'), adm.getByTestId('imp-template').click()]);
await check(tplDl.suggestedFilename() === 'QuickCome-matches-template.xlsx', `模板文件名：${tplDl.suggestedFilename()}`);
const tplFile = path.join(state, 'template.xlsx');
await tplDl.saveAs(tplFile);
const tpl = XLSX.read(readFileSync(tplFile));
const tplSheet = tpl.Sheets[tpl.SheetNames[0]];
const tplHead = XLSX.utils.sheet_to_json(tplSheet, { header: 1 })[0];
await check(JSON.stringify(tplHead) === JSON.stringify(['聯賽', '主隊', '客隊', '開賽時間（台灣）', '備註']), `模板表头：${tplHead}`);
XLSX.utils.sheet_add_aoa(tplSheet, [
  ['英超', '兵工廠', '利物浦', `${tw(3)} 00:30`, '週日'],
  ['中職', '中信兄弟', '統一獅', `${tw(4).replace(/-/g, '/')} 18:35`, ''],
], { origin: 'A2' });
const filled = { name: '焦點戰.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(tpl, { type: 'buffer', bookType: 'xlsx' }) };
await adm.getByTestId('imp-file').setInputFiles(filled);
await waitPreview(adm);
await check((await adm.getByTestId('imp-rows').textContent()).includes('导入后首页显示'), '导入预览不对');
await shot(adm, '10-焦点战编辑和导入预览-1440.png', { admin: true });
await adm.getByTestId('imp-confirm').click();
await adm.getByText('已导入 2 场，首页已更新。').waitFor();
await adm.getByTestId('match-rows').getByText('中信兄弟 vs 統一獅').waitFor();
// 手机：编辑表单和导入预览（用同一个文件预览，不导入）
await madm.reload();
await madm.getByTestId('match-rows').waitFor();
await madm.getByTestId('imp-file').setInputFiles(filled);
await waitPreview(madm);
await shot(madm, '10-焦点战编辑和导入预览-390.png', { admin: true });
await home.reload();
await home.getByText('湖人 vs 勇士').waitFor();
await home.getByText('兵工廠 vs 利物浦').waitFor();
await home.getByText('中信兄弟 vs 統一獅').waitFor();
await check(!(await home.evaluate(() => document.body.innerText)).includes('上線後這裡顯示'), '首页焦点战还有"上線後這裡顯示…"');
await check((await home.locator('[data-testid="match"] .split').count()) === 0, '焦点战卡片上有比例条');
await shot(home, '11-首页有焦点战-1440.png');
await mhome.goto(`${BASE}/`);
await mhome.getByText('中信兄弟 vs 統一獅').waitFor();
await shot(mhome, '11-首页有焦点战-390.png');
ok('焦点战：联赛下拉、日期时间选择器（台湾时间）；下载模板填 2 场导入（先预览）；首页显示 3 场，只有联赛、对战、时间');

// 导出 Excel
await adm.getByTestId('export-pw').fill('wrong-password-for-e2e');
await adm.getByTestId('export-btn').click();
await adm.getByText('密码核对失败，请稍后再试。').waitFor();
await adm.getByTestId('export-pw').fill(PASSWORD);
const [download] = await Promise.all([adm.waitForEvent('download'), adm.getByTestId('export-btn').click()]);
await check(/^QuickCome-list-TEST-\d{4}-\d{2}-\d{2}\.xlsx$/.test(download.suggestedFilename()), `导出文件名：${download.suggestedFilename()}`);
const xfile = path.join(state, 'export.xlsx');
await download.saveAs(xfile);
const wb = XLSX.read(readFileSync(xfile));
const table = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
const HEAD = ['電子信箱', '狀態', '願意內測', '來源', '活動', '邀請人', '邀請成功人數', '語言', '留信箱時間（台灣）', '確認時間（台灣）', '退訂時間（台灣）'];
await check(JSON.stringify(table[0]) === JSON.stringify(HEAD), `导出表头：${table[0]}`);
const byEmail = Object.fromEntries(table.slice(1).map((r) => [r[0], r]));
await check(table.length === 4, `导出人数：${table.length - 1}`);
const o = byEmail[owner];
await check(o && o[1] === '已確認' && o[2] === '是' && o[3] === 'Threads' && o[4] === 'e2e' && o[5] === '' && o[6] === 1 && o[7] === '繁體中文' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(o[9]), `导出里的本人：${JSON.stringify(o)}`);
const f = byEmail[friend];
await check(f && f[3] === '訂閱者邀請' && f[5] === owner && f[2] === '否', `导出里的朋友：${JSON.stringify(f)}`);
await check(!/\binvite\b|confirmed|zh-TW|M-\d/.test(JSON.stringify(table)), '导出里有内部写法');
await check((await adm.getByTestId('export-pw').inputValue()) === '', '导出后密码框没清空');
await shot(adm, '12-导出-1440.png', { admin: true });
await shot(madm, '12-导出-390.png', { admin: true });
ok(`导出：密码错提示通用；下载 ${download.suggestedFilename()}，用库读回：中文表头、"已確認""訂閱者邀請"、邀请人完整邮箱、台湾时间`);

// 在专属页面退订
await mpage.reload();
await mpage.getByTestId('sub-unsub-open').click();
await mpage.getByTestId('sub-unsub-yes').click();
await mpage.getByTestId('sub-unsubscribed').waitFor();
await mpage.reload();
await mpage.getByTestId('sub-unsubscribed').waitFor();
await shot(mpage, '13-专属页面-已退订-390.png');
const dun = await desktop.newPage();
await dun.goto(pageUrl);
await dun.getByTestId('sub-unsubscribed').waitFor();
await shot(dun, '13-专属页面-已退订-1440.png');
await dun.close();
ok('退订：在专属页面按"取消訂閱"再确认；刷新后仍显示"你已經取消訂閱"和"重新訂閱"');

await adm.getByTestId('logout').click();
await adm.getByTestId('admin-login').waitFor();
await check((await fetch(`${BASE}${OPS}/api/metrics`)).status === 401, '没有 Cookie 时名单接口不是 401');
ok('登出：回到密码框');

// ---------- 测试版：公开页面不要密码、不收录；名单页要密码 ----------
startDev('staging', STAGING_PORT, ['--env=staging', '--var', 'ENVIRONMENT:staging', '--var', `ADMIN_PASSWORD:${PASSWORD}`, '--var', `ADMIN_PATH:${OPS}`, '--var', `PUBLIC_BASE_URL:http://localhost:${STAGING_PORT}`]);
const SB = `http://localhost:${STAGING_PORT}`;
const sh = await waitFor(async () => (await fetch(`${SB}/api/health`)).json(), '测试版 wrangler dev 启动', 90_000);
await check(sh.environment === 'staging', `测试版健康检查：${JSON.stringify(sh)}`);
const sHome = await fetch(`${SB}/`);
await check(sHome.status === 200 && (await sHome.text()).includes('qc-site'), `测试版首页不能直接打开：${sHome.status}`);
await check(sHome.headers.get('x-robots-tag') === 'noindex, nofollow', `测试版首页没有 noindex：${sHome.headers.get('x-robots-tag')}`);
await check((await (await fetch(`${SB}/robots.txt`)).text()).includes('Disallow: /\n'), '测试版 robots.txt 没有禁止收录');
await check((await fetch(`${SB}/api/public/matches`)).status === 200, '测试版公开接口要密码');
await check((await fetch(`${SB}${OPS}/api/metrics`)).status === 401, '测试版名单页接口没要密码');
// 正式版配置 + 本机环境（local，不是 production）：同样禁止收录；正式版（production）用静态 robots.txt 由单元测试检查
await check((await (await fetch(`${BASE}/robots.txt`)).text()).includes('Disallow: /\n'), '本机的 robots.txt 没有禁止收录');
const sp = await mobile.newPage();
await sp.goto(`${SB}/`);
await sp.getByRole('button', { name: '上線時通知我' }).waitFor();
await check((await sp.getByTestId('env-banner').textContent()).includes('測試環境'), '测试版没有黄色测试环境条');
await sp.close();
// 新的浏览器环境：本机的两个服务都在 localhost，Cookie 不分端口，避免带着上面的会话
const sdesk = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW' });
const smob = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
watch(sdesk);
watch(smob);
const sa = await sdesk.newPage();
await sa.goto(`${SB}${OPS}`);
await sa.getByLabel('密码').fill(PASSWORD);
await sa.getByRole('button', { name: '登录' }).click();
await sa.getByTestId('kpi-beta-note').waitFor();
await check((await sa.getByTestId('kpi-beta-note').textContent()).includes('还没有人勾选「我愿意参加内测」'), '内测 0 人没有说明');
await sa.getByTestId('filter-beta').check();
await sa.getByTestId('list-empty').waitFor();
await shot(sa, '14-名单页内测0人说明-1440.png', { admin: true });
const msa = await smob.newPage();
await msa.goto(`${SB}${OPS}`);
await msa.getByLabel('密码').fill(PASSWORD);
await msa.getByRole('button', { name: '登录' }).click();
await msa.getByTestId('kpi-beta-note').waitFor();
await shot(msa, '14-名单页内测0人说明-390.png', { admin: true });
ok('测试版：首页和公开接口不要密码，有黄色测试环境条、X-Robots-Tag noindex、robots.txt 禁止收录；名单页要密码；空库时"愿意内测"写明 0 人的原因');

await check(pageErrors.length === 0, `页面脚本出错：${pageErrors.join('；')}`);
await browser.close();
if (screenshots) ok(`截图 ${shotList.length} 张（每张都先过自动检查）：${path.relative(repo, SHOTS)}/`);
await cleanup();
console.log('本机端到端全部通过');
process.exit(0);
