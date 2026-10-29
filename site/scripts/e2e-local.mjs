#!/usr/bin/env node
/**
 * 本机端到端（Playwright + wrangler dev）：用真实的配置 site/wrangler.toml 和构建好的 site/dist，在本地 workerd + 本地 D1 上走一遍：
 *   首页（电脑 1440、手机 390，主按钮在首屏内 C79）→ 留邮箱（勾内测、带来源）→ 打开确认链接（不自动确认）→ 按确认 → 充值提醒和邀请链接
 *   → 朋友用 ?ref=邀请码 留邮箱并确认 → 私密邀请页显示 1 人 → 名单页登录（密码每次运行随机生成，不打印、不进截图）→ 指标、名单（打码）
 *   → 编辑焦点战 → 首页看到 → 导出（再输一次密码，完整邮箱）→ 退订 → 交易类接口 404；
 *   另起一个测试版（--env staging）检查整站密码门。
 * 发信：Resend 用本机替身（RESEND_API_URL 只在 ENVIRONMENT = local 时生效），从替身收到的邮件里取链接，同时检查邮件内容。
 * 行情：定时任务会真的去取 OKX / 币安；本机网络取不到时只记"看板：暂时取不到"，不算失败。
 * 截图：assets/v1/site/（仓库是公开的：截图里没有密码，名单页的邮箱是打码的）。
 * 用法：npm run build && node scripts/e2e-local.mjs [--no-screenshots]。每步一行 ✓ / ✗，失败时停下并打印 wrangler 的日志。
 * 参照：forecast main 0caa740 cf/scripts/e2e-local.sh（改用 Node + Playwright，加了页面操作和截图）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(site, '..');
const SHOTS = path.join(repo, 'assets/v1/site');
const screenshots = !process.argv.includes('--no-screenshots');
const PORT = Number(process.env.E2E_PORT || 8799);
const GATE_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const state = mkdtempSync(path.join(tmpdir(), 'qc-e2e-'));
const PASSWORD = randomBytes(18).toString('base64url'); // 每次运行随机，≥ 16 个字符，不打印
const procs = [];
const logs = {};
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };

function ok(msg) {
  console.log(`✓ ${msg}`);
}
function note(msg) {
  console.log(`· ${msg}`);
}
async function fail(msg) {
  console.error(`✗ ${msg}`);
  for (const [name, buf] of Object.entries(logs)) console.error(`---- ${name} 日志（最后 40 行）----\n${buf.split('\n').slice(-40).join('\n')}`);
  await cleanup();
  process.exit(1);
}
function check(cond, msg) {
  if (!cond) return fail(msg);
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
    await new Promise((r) => setTimeout(r, 500));
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

const mailFor = (to) => waitFor(() => [...mails].reverse().find((m) => m.to?.[0] === to), `寄给 ${to} 的确认邮件`, 15_000);
const linksOf = (text) => text.match(/http:\/\/localhost:\d+\S+/g) ?? [];

// ---------- 准备 ----------
check(existsSync(path.join(site, 'dist/index.html')), '没有 site/dist：先运行 npm run build');
// 本机用的配置：和正式版一样，只多一条——/__scheduled 先进 Worker（wrangler dev --test-scheduled 用它触发定时任务）
const toml = readFileSync(path.join(site, 'wrangler.toml'), 'utf8').replace('run_worker_first = ["/api/*", "/admin*"]', 'run_worker_first = ["/api/*", "/admin*", "/__scheduled"]');
check(toml.includes('"/__scheduled"'), '生成本机配置失败');
writeFileSync(path.join(site, 'wrangler.e2e.toml'), toml);
for (const [name, e] of [
  ['prod', ''],
  ['staging', 'staging'],
]) {
  try {
    execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', e ? 'new-forecast-site-staging' : 'new-forecast-site', '-c', 'wrangler.e2e.toml', '--local', `--env=${e}`, '--persist-to', path.join(state, name)], {
      cwd: site,
      env,
      stdio: 'pipe',
    });
  } catch (err) {
    await fail(`本地 D1 迁移失败（${name}）：${String(err.stderr || err).slice(0, 500)}`);
  }
}
ok('本地 D1 迁移（正式版、测试版各一个库）');

startDev('prod', PORT, [
  '--env=',
  '--test-scheduled',
  '--var', 'ENVIRONMENT:local',
  '--var', `PUBLIC_BASE_URL:${BASE}`,
  '--var', 'VERSION:e2e-local',
  '--var', 'RESEND_API_KEY:e2e_dummy_key',
  '--var', `RESEND_API_URL:${MAIL_URL}`,
  '--var', `ADMIN_PASSWORD:${PASSWORD}`,
  '--var', 'BACKUP_URL:https://new-forecast-site.example.workers.dev',
]);
const health = await waitFor(async () => (await fetch(`${BASE}/api/health`)).json(), 'wrangler dev 启动', 90_000);
check(health.status === 'UP' && health.version === 'e2e-local' && health.checks.mail === 'ok' && health.checks.admin === 'ok' && health.checks.gate === 'off', `健康检查：${JSON.stringify(health)}`);
check(!JSON.stringify(health).includes(PASSWORD), '健康检查里出现了密码');
ok(`wrangler dev 启动；健康检查 UP、mail ok（替身）、admin ok、gate off`);

// 交易类接口一律 404
for (const p of ['/api/auth/login', '/api/auth/register', '/api/me', '/api/bets', '/api/wallet/deposit-address', '/api/withdraw', '/api/markets']) {
  const s = (await fetch(`${BASE}${p}`)).status;
  check(s === 404, `${p} 应该 404，实际 ${s}`);
}
ok('交易、账户类接口一律 404');

// 定时任务取行情
await fetch(`${BASE}/__scheduled?cron=*/5+*+*+*+*`);
const board = await waitFor(async () => {
  const h = await (await fetch(`${BASE}/api/health`)).json();
  return h.checks.board.sources.length >= 1 ? h.checks.board : null;
}, '定时任务跑完', 30_000);
if (board.status === 'ok') ok(`定时任务取到行情：来源 ${board.source}`);
else note(`看板：本机网络取不到 OKX / 币安（${board.sources.map((s) => `${s.source}: ${s.error}`).join('；')}），页面显示"暂时取不到"`);

// ---------- 页面 ----------
if (screenshots) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const shot = async (page, name) => {
  if (screenshots) await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
};
const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW', acceptDownloads: true });
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
for (const ctx of [desktop, mobile]) ctx.setDefaultTimeout(15_000);
const pageErrors = [];
for (const ctx of [desktop, mobile]) ctx.on('page', (p) => p.on('pageerror', (e) => pageErrors.push(String(e))));

// 首页：电脑 1440 两栏、手机 390 单栏、主按钮在首屏内（C79）
const home = await desktop.newPage();
await home.goto(`${BASE}/?src=threads&cmp=e2e`);
await home.getByRole('button', { name: '上線時通知我' }).waitFor();
check(await home.locator('[data-layout="desktop"]').count() === 1, '电脑版首页不是两栏');
await home.getByTestId('btc-card').waitFor();
await home.waitForFunction(() => !document.querySelector('[data-testid="btc-card"]')?.textContent?.includes('讀取中'));
check((await home.getByTestId('env-banner').textContent()).includes('測試環境'), '本机（local）应该有测试环境标识条');
check((await home.getByTestId('backup-url').textContent()).includes('new-forecast-site.example.workers.dev'), '页脚没有备用网址（M-12）');
let box = await home.getByRole('button', { name: '上線時通知我' }).boundingBox();
check(box && box.y + box.height <= 900, `1440×900 下"上線時通知我"不在首屏内（底边 ${box?.y + box?.height}）`);
await shot(home, '01-首页-电脑1440.png');
const mhome = await mobile.newPage();
await mhome.goto(`${BASE}/`);
await mhome.getByRole('button', { name: '上線時通知我' }).waitFor();
check(await mhome.locator('[data-layout="mobile"]').count() === 1, '手机版首页不是单栏');
box = await mhome.getByRole('button', { name: '上線時通知我' }).boundingBox();
check(box && box.y + box.height <= 844, `390×844 下"上線時通知我"不在首屏内（底边 ${box?.y + box?.height}）`);
const overflow = await mhome.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, `手机版横向溢出 ${overflow}px`);
await mhome.getByTestId('btc-card').waitFor();
await mhome.waitForFunction(() => !document.querySelector('[data-testid="btc-card"]')?.textContent?.includes('讀取中'));
await shot(mhome, '02-首页-手机390.png');
ok('首页：电脑两栏、手机单栏，主按钮在 1440×900 和 390×844 的首屏内，手机无横向溢出，有测试标识条和备用网址');

// 留邮箱（勾内测、带来源）
const owner = `owner-${Date.now()}@example.com`;
await home.getByLabel('電子信箱').fill(owner);
await home.getByRole('checkbox', { name: /我願意參加內測/ }).check();
await home.getByRole('button', { name: '上線時通知我' }).click();
await home.getByTestId('subscribe-done').waitFor();
const m1 = await mailFor(owner);
check(m1.auth === 'Bearer e2e_dummy_key', '发信没带 key');
check(m1.subject.startsWith('[測試環境] 請確認訂閱'), `邮件标题：${m1.subject}`);
check(m1.text.includes('BEP20') && m1.text.includes('TRC20'), '确认邮件里没有充值提醒（M-4）');
const [confirmUrl, inviteUrl, unsubUrl] = linksOf(m1.text);
check(confirmUrl?.includes('/confirm?t=') && inviteUrl?.includes('/invite?k=') && unsubUrl?.includes('/unsubscribe?t='), `邮件里的链接：${linksOf(m1.text)}`);
ok('留邮箱：页面显示"请到信箱收确认信"；确认邮件（繁中、测试标识、BEP20 提醒、确认 / 私密邀请页 / 退订三个链接）');

// 打开确认链接：不自动确认；按按钮才确认
const conf = await desktop.newPage();
await conf.goto(confirmUrl);
await conf.getByTestId('confirm-btn').waitFor();
await conf.waitForTimeout(500);
const pendingInvite = await (await fetch(`${BASE}/api/public/invite?k=${new URL(inviteUrl).searchParams.get('k')}`)).json();
check(pendingInvite.status === 'pending', `打开确认页就被确认了：${JSON.stringify(pendingInvite)}`);
await conf.getByTestId('confirm-btn').click();
await conf.getByTestId('confirm-ok').waitFor();
check((await conf.getByTestId('confirm-ok').textContent()).includes('願意參加內測'), '确认页没提内测');
check((await conf.getByTestId('deposit-tip').textContent()).includes('BEP20'), '确认页没有充值提醒');
const inviteLink = (await conf.getByTestId('invite-link').textContent()).trim();
const code = new URL(inviteLink).searchParams.get('ref');
check(/^[2-9A-HJKMNP-Z]{6}$/.test(code), `邀请链接：${inviteLink}`);
check((await conf.getByTestId('invite-count').textContent()).includes('0 人'), '新订阅者的邀请数不是 0');
await shot(conf, '03-确认页-电脑1440.png');
const mconf = await mobile.newPage();
await mconf.goto(confirmUrl);
await mconf.getByTestId('confirm-btn').click();
await mconf.getByTestId('invite-panel').waitFor();
await shot(mconf, '04-确认页-手机390.png');
ok(`确认：打开链接不自动确认，按"確認訂閱"后显示成功、充值提醒、邀请链接（邀请码 ${code}）`);

// 朋友用 ?ref=邀请码 进来留邮箱并确认
const friendCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-TW' });
const fp = await friendCtx.newPage();
const friend = `friend-${Date.now()}@example.com`;
await fp.goto(`${BASE}/?ref=${code}`);
await fp.getByLabel('電子信箱').fill(friend);
await fp.getByRole('button', { name: '上線時通知我' }).click();
await fp.getByTestId('subscribe-done').waitFor();
const m2 = await mailFor(friend);
await fp.goto(linksOf(m2.text)[0]);
await fp.getByTestId('confirm-btn').click();
await fp.getByTestId('confirm-ok').waitFor();
await friendCtx.close();
const inv = await mobile.newPage();
await inv.goto(inviteUrl);
await inv.getByTestId('invite-count').waitFor();
check((await inv.getByTestId('invite-count').textContent()).includes('1 人'), `私密邀请页人数：${await inv.getByTestId('invite-count').textContent()}`);
await shot(inv, '07-邀请页-手机390.png');
ok('邀请：朋友用 ?ref=邀请码 留邮箱并确认后，私密邀请页显示"你已邀請 1 人"（不需要登录）');

// 名单页：登录 → 指标 → 名单 → 焦点战 → 首页看到 → 导出
const adm = await desktop.newPage();
await adm.goto(`${BASE}/admin`);
await adm.getByTestId('admin-login').waitFor();
await adm.getByLabel('密码').fill('wrong-password-for-e2e');
await adm.getByRole('button', { name: '登录' }).click();
await adm.getByText(/密码不对/).waitFor();
await adm.getByLabel('密码').fill(PASSWORD);
await adm.getByRole('button', { name: '登录' }).click();
await adm.getByTestId('kpi-confirmed').waitFor();
const cookies = await desktop.cookies();
const sess = cookies.filter((c) => c.name === 'qc_admin');
check(sess.length === 2 && sess.every((c) => c.httpOnly && c.secure && c.sameSite === 'Strict') && sess.map((c) => c.path).sort().join() === '/admin,/api/admin', `会话 Cookie：${JSON.stringify(sess.map(({ value: _v, ...c }) => c))}`);
check((await adm.getByTestId('kpi-confirmed').textContent()) === '2', `累计确认：${await adm.getByTestId('kpi-confirmed').textContent()}`);
check((await adm.getByTestId('kpi-beta').textContent()) === '1', '内测人数不是 1');
check((await adm.getByTestId('kpi-today').textContent()) === '2', '今天新增不是 2');
const channels = await adm.getByTestId('channels').textContent();
check(channels.includes('訂閱者邀請') || channels.includes('订阅者邀请'), `来源表没有订阅者邀请：${channels}`);
await adm.getByTestId('sub-rows').waitFor();
const rows = await adm.getByTestId('sub-rows').textContent();
check(!rows.includes(owner) && rows.includes('o***@example.com'), '名单里的邮箱没有打码');
await adm.getByTestId('filter-beta').check();
await adm.waitForFunction(() => document.querySelector('[data-testid="list-total"]')?.textContent?.includes('共 1 人'));
await adm.getByTestId('filter-beta').uncheck();
ok('名单页：密码错有提示；登录后 Cookie 是 HttpOnly + Secure + SameSite=Strict、只在 /admin 和 /api/admin；指标 2 确认 / 1 内测 / 今天 2；邮箱打码；内测筛选 1 人');

// 焦点战：先故意填错，看一次提示全部错误；再填对
const tw = (d) => new Date(Date.now() + d * 86400_000 + 8 * 3600_000).toISOString().slice(0, 10);
await adm.getByTestId('m-startsAt').fill('明天');
await adm.getByTestId('m-save').click();
await adm.getByText(/有 3 处要改/).waitFor();
await adm.getByTestId('m-league').fill('NBA');
await adm.getByTestId('m-title').fill('湖人 vs 勇士');
await adm.getByTestId('m-startsAt').fill(`${tw(2).replace(/-0?/g, '/').replace(/^(\d+)\//, '$1/')} 9:30`);
await adm.getByTestId('m-save').click();
await adm.getByText('已保存，首页已更新。').waitFor();
await adm.getByTestId('m-league').fill('英超');
await adm.getByTestId('m-title').fill('兵工廠 vs 利物浦');
await adm.getByTestId('m-startsAt').fill(`${tw(3)} 00:30`);
await adm.getByTestId('m-note').fill('每週日更新這一區');
await adm.getByTestId('m-save').click();
await adm.getByTestId('match-rows').getByText('兵工廠 vs 利物浦').waitFor();
check((await adm.getByTestId('match-rows').textContent()).includes(`${tw(2)} 09:30`), '时间没有整理成标准写法');
await adm.reload();
await adm.getByTestId('match-rows').waitFor();
await shot(adm, '05-名单页-电脑1440.png');
const madm = await mobile.newPage();
await madm.goto(`${BASE}/admin`);
await madm.getByTestId('admin-login').waitFor();
await madm.getByLabel('密码').fill(PASSWORD);
await madm.getByRole('button', { name: '登录' }).click();
await madm.getByTestId('match-rows').waitFor();
await madm.getByTestId('sub-rows').waitFor();
await shot(madm, '06-名单页-手机390.png');
await home.reload();
await home.getByText('湖人 vs 勇士').waitFor();
await home.getByText('兵工廠 vs 利物浦').waitFor();
await shot(home, '09-首页有焦点战-电脑1440.png');
ok('焦点战：一次提示 3 处错误；"年/月/日 9:30"自动整理成"年-月-日 09:30"；新增 2 场后首页立刻显示');

// 导出：要再输一次密码
await adm.getByTestId('export-pw').fill('wrong-password-for-e2e');
await adm.getByTestId('export-btn').click();
await adm.getByText(/密码不对/).waitFor();
await adm.getByTestId('export-pw').fill(PASSWORD);
const [download] = await Promise.all([adm.waitForEvent('download'), adm.getByTestId('export-btn').click()]);
const file = path.join(state, 'export.json');
await download.saveAs(file);
const exp = JSON.parse(readFileSync(file, 'utf8'));
check(exp.format === 'qc-waitlist-v1' && exp.count === 2, `导出：${JSON.stringify({ format: exp.format, count: exp.count })}`);
const me = exp.items.find((x) => x.email === owner);
check(me && me.beta === true && me.status === 'confirmed' && me.invitedCount === 1 && me.src === 'threads' && me.cmp === 'e2e', `导出里的本人：${JSON.stringify(me)}`);
check(exp.items.find((x) => x.email === friend)?.channel === 'invite', '导出里朋友的来源不是 invite');
check((await adm.getByTestId('export-pw').inputValue()) === '', '导出后密码框没清空');
ok(`导出：密码错有提示；再输一次密码后下载 ${download.suggestedFilename()}（qc-waitlist-v1，完整邮箱 2 人，含内测、来源、邀请数）`);

// 退订
const un = await mobile.newPage();
await un.goto(unsubUrl);
await un.getByRole('button', { name: '確認退訂' }).click();
await un.getByTestId('unsub-done').waitFor();
ok('退订：不用登录，按"確認退訂"后完成');

// 登出
await adm.getByTestId('logout').click();
await adm.getByTestId('admin-login').waitFor();
check((await (await fetch(`${BASE}/api/admin/metrics`)).status) === 401, '没有 Cookie 时名单接口不是 401');
ok('登出：回到密码框');
check(pageErrors.length === 0, `页面脚本出错：${pageErrors.join('；')}`);

// ---------- 测试版：整站密码门 ----------
startDev('staging', GATE_PORT, ['--env=staging', '--var', 'ENVIRONMENT:staging', '--var', `ADMIN_PASSWORD:${PASSWORD}`]);
const GB = `http://localhost:${GATE_PORT}`;
const gh = await waitFor(async () => (await fetch(`${GB}/api/health`)).json(), '测试版 wrangler dev 启动', 90_000);
check(gh.checks.gate === 'on' && gh.environment === 'staging', `测试版健康检查：${JSON.stringify(gh)}`);
const gp = await mobile.newPage();
const first = await gp.goto(`${GB}/`);
check(first.status() === 401, `测试版首页没过密码门：${first.status()}`);
await gp.getByText('測試環境 · TEST').waitFor();
check((await fetch(`${GB}/api/public/board`)).status === 401, '测试版接口没过密码门');
await shot(gp, '08-测试版密码门-手机390.png');
await gp.locator('#pw').fill(PASSWORD);
await gp.getByRole('button', { name: /進入/ }).click();
await gp.getByRole('button', { name: '上線時通知我' }).waitFor();
check((await gp.getByTestId('env-banner').textContent()).includes('staging'), '测试版页面没有测试环境标识条');
ok('测试版：没输密码时页面 401（顶部"测试环境"标识条）、接口 401、健康检查照常；输对密码后整站可用并显示测试标识条');

await browser.close();
if (screenshots) ok(`截图：${path.relative(repo, SHOTS)}/（9 张）`);
await cleanup();
console.log('本机端到端全部通过');
process.exit(0);
