#!/usr/bin/env node
/**
 * 构建产物检查（需求单第三节底线：页面上没有注册、登录、充值、下注的入口）。CI 每次构建后运行，有一项不对就失败。
 * 一、不能有的（所有 .html、.js 里查）：
 *   - 交易、账户类接口：/api/auth、/api/me、/api/bet(s)、/api/wallet、/api/account、/api/markets、/api/order(s)、/api/deposit、/api/withdraw、/api/kyc、/api/trade、/api/register、/api/signup
 *   - 交易、账户类页面路径："/login"、"/register"、"/signup"、"/markets"、"/wallet"、"/deposit"、"/withdraw"、"/bet(s)"、"/trade"、"/account"、"/me"（以及它们下面的子路径）
 *   - 测试环境的地址（workers.dev）不能写死进页面
 * 二、名单页不能被猜到（v1.1：名单页的地址是密钥 ADMIN_PATH，只由 Worker 提供 console.html）：
 *   - 产物里没有名字带 "admin" 的文件，任何 .html 里没有 "admin" 字样；
 *   - 公开页面（index.html 和它引用的 JS）里没有名单页接口（/api/admin、/api/login 这类）和名单页的 HTML（console.html）。
 * 三、必须有的：index.html（meta qc-site = prelaunch、分享卡片 og:image）、console.html（名单页）、og-return-rate.png、robots.txt、sitemap.xml、_headers、favicon.svg；
 *   公开页面里有留邮箱、专属页面（确认、邀请）、退订、看板、焦点战的接口。
 * 用法：node scripts/check-dist.mjs [目录，默认 site/dist]
 * 参照：forecast main 0caa740 cf/scripts/check-dist.mjs。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FORBIDDEN = [
  [/\/api\/(auth|me|bets?|wallet|account|markets|orders?|deposit|withdraw|kyc|trade|register|signup)\b/, '交易或账户类接口'],
  [/["'`]\/(login|register|signup|markets|wallet|deposit|withdraw|bets?|trade|account|me)(["'`?#]|\/)/, '交易或账户类页面的路径'],
  [/[a-z0-9-]+\.workers\.dev/, '写死的 workers.dev 地址（备用网址由 /api/public/site 给）'],
];

export const PUBLIC_APIS = ['/api/public/subscribe', '/api/public/confirm', '/api/public/unsubscribe', '/api/public/subscription', '/api/public/board', '/api/public/matches'];

function walk(d, out = []) {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** index.html 引用的 JS，以及这些 JS 再 import 的 JS（Vite 产物里的写法 from"./x.js" / import("./x.js")） */
export function reachable(root, entry) {
  const seen = new Set();
  const html = readFileSync(path.join(root, entry), 'utf8');
  const queue = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = path.join(root, rel);
    if (!existsSync(file)) continue;
    const js = readFileSync(file, 'utf8');
    for (const m of js.matchAll(/["'`]\.\/([^"'`]+\.js)["'`]/g)) queue.push(path.posix.join(path.posix.dirname(rel), m[1]));
  }
  return [...seen];
}

export function check(root) {
  const problems = [];
  if (!existsSync(root)) return [`${root} 不存在，先运行 npm run build`];
  const files = walk(root);
  for (const f of files.filter((x) => /\.(html|js)$/.test(x))) {
    const s = readFileSync(f, 'utf8');
    for (const [re, what] of FORBIDDEN) {
      const m = s.match(re);
      if (m) problems.push(`${path.relative(root, f)}：有${what}「${m[0]}」`);
    }
  }
  for (const f of files) {
    const rel = path.relative(root, f);
    if (/admin/i.test(rel)) problems.push(`有名字带 admin 的文件：${rel}（名单页的地址不能被猜到）`);
    if (/\.html$/.test(f) && /admin/i.test(readFileSync(f, 'utf8'))) problems.push(`${rel} 里有 "admin" 字样（名单页的地址不能被猜到）`);
  }
  for (const rel of ['index.html', 'console.html', 'og-return-rate.png', 'robots.txt', 'sitemap.xml', '_headers', 'favicon.svg']) {
    if (!existsSync(path.join(root, rel))) problems.push(`缺少 ${rel}`);
  }
  if (existsSync(path.join(root, 'index.html'))) {
    const idx = readFileSync(path.join(root, 'index.html'), 'utf8');
    if (!/<meta name="qc-site" content="prelaunch"/.test(idx)) problems.push('index.html 没有 <meta name="qc-site" content="prelaunch">');
    if (!/<meta property="og:image" content="https:\/\/[^"]+\/og-return-rate\.png"/.test(idx)) problems.push('index.html 没有分享卡片 og:image（og-return-rate.png）');
    const pub = reachable(root, 'index.html');
    if (pub.length === 0) problems.push('index.html 没有引用任何 JS');
    const text = pub.map((r) => readFileSync(path.join(root, r), 'utf8')).join('\n');
    if (text.includes('/api/admin')) problems.push(`公开页面的 JS 里有名单页接口 /api/admin（${pub.join('、')}）`);
    if (/\/api\/(login|logout|session|metrics|subscribers|export)\b/.test(text)) problems.push(`公开页面的 JS 里有名单页的接口（${pub.join('、')}）`);
    if (/console(\.html|-[A-Za-z0-9_-]+\.js)/.test(text)) problems.push(`公开页面的 JS 里引用了名单页（${pub.join('、')}）`);
    for (const a of PUBLIC_APIS) if (!text.includes(a)) problems.push(`公开页面里没有接口 ${a}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] || path.join(site, 'dist'));
  const problems = check(dir);
  if (problems.length) {
    console.error(`产物检查没有通过（${problems.length} 处）：`);
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log(`产物检查通过：${dir} 里没有交易类入口，公开页面里没有名单页接口`);
}
