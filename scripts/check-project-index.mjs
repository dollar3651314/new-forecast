#!/usr/bin/env node
// 项目地图和项目索引的通用检查（agents 规则 C53、C54）。不依赖任何库，Node 18 以上即可，项目用什么语言都能用。
// 用法：在项目根目录执行  node scripts/check-project-index.mjs  （配置文件默认是根目录的 项目索引.config.json）
// 新项目：把本文件原样复制到项目的 scripts/ 下，再按 agents/模板/项目索引.config.json 写配置。
// 不要在项目里修改本文件；要改进，改 agents 仓库里的这一份，再复制过去（文件头的版本号会变）。
// 版本：v2（2026-10-27，agents C96：支持 external，私有仓库里的文件不算缺失）；v1（2026-10-01）
//
// 检查的内容：
//   ① 入口文件（CLAUDE.md、AGENTS.md）存在，并指向项目地图；项目地图指向项目索引
//   ② files.include 范围内的每个文件（git 跟踪的 + 新建还没提交的）都在索引里写过（用反引号包起来的完整路径）
//   ③ 索引里写到的路径都真实存在（含 * 或 < 的通配写法除外）
//   ④ lists：按配置从代码里提取名单（环境变量、数据库表、接口动作……），检查索引的对应章节都写了；
//      twoWay 为 true 时，章节第一列里写到的名字也必须还在代码里出现（防止写了已经删除的）
//   ⑤ external（v2，C96）：内部文档放在别的仓库（例如私有仓库 <项目>-private）时，索引里写成 `<前缀>路径`（例如 `forecast-private/Amos待办.md`），
//      这些路径不在本仓库检查是否存在；项目地图和项目索引都必须提到这个仓库（前缀或 repo 名），保证新来的人知道去哪里找
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const cfgPath = process.argv[2] || '项目索引.config.json';
if (!existsSync(join(ROOT, cfgPath))) { console.error(`找不到配置文件 ${cfgPath}（模板见 agents/模板/项目索引.config.json）`); process.exit(2); }
const cfg = JSON.parse(readFileSync(join(ROOT, cfgPath), 'utf8'));
const MAP = cfg.map || '项目地图.md';
const INDEX = cfg.index || '项目索引.md';
const problems = [];
const external = (cfg.external || []).map((e) => (typeof e === 'string' ? { prefix: e } : e)).filter((e) => e.prefix);
const isExternal = (t) => external.some((e) => t.startsWith(e.prefix));
let scope = [];
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

// ① 入口
for (const f of [MAP, INDEX, ...(cfg.entry || ['CLAUDE.md', 'AGENTS.md'])]) if (!existsSync(join(ROOT, f))) problems.push(`缺少文件：${f}`);
if (problems.length) finish();
for (const f of cfg.entry || ['CLAUDE.md', 'AGENTS.md']) if (!read(f).includes(MAP)) problems.push(`${f} 没有指向 ${MAP}`);
if (!read(MAP).includes(INDEX)) problems.push(`${MAP} 没有指向 ${INDEX}`);
// ⑤ 外部仓库：地图和索引都要提到
for (const e of external) for (const f of [MAP, INDEX]) {
  const text = read(f);
  if (!text.includes(e.prefix.replace(/\/$/, '')) && !(e.repo && text.includes(e.repo))) problems.push(`${f} 没有提到存放内部文档的仓库 ${e.repo || e.prefix}（external）`);
}

const index = read(INDEX);
const ticks = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const written = new Set(ticks(index));

// ② 文件都写进了索引
let files;
try {
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f && existsSync(join(ROOT, f)));
} catch { console.error('需要在 git 仓库里运行'); process.exit(2); }
const glob = (p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(.*/)?').replace(/\u0002/g, '.*') + '$');
const inc = (cfg.files?.include || []).map(glob), exc = (cfg.files?.exclude || []).map(glob);
scope = files.filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)));
for (const f of scope) if (!written.has(f)) problems.push(`没有写进索引的文件：${f}`);

// ③ 写到的路径都存在
const dirs = new Set(files.map((f) => f.split('/')[0]).filter((d) => files.some((f) => f.startsWith(`${d}/`))));
for (const t of written) {
  if (/[*<\s]/.test(t) || isExternal(t)) continue;
  const looksLikePath = dirs.has(t.split('/')[0]) && t.includes('/') || (/^[^/]+\.[A-Za-z]+$/.test(t) && files.includes(t)) || /^[^/]+\.(md|json|ya?ml|toml)$/.test(t);
  if (looksLikePath && !existsSync(join(ROOT, t))) problems.push(`索引里写到的路径不存在：${t}${external.length ? `（在私有仓库里的，写成 \`${external[0].prefix}${t}\`）` : ''}`);
}

// ④ 名单
/** 取某一节：标题包含 title 的那一行，到下一个同级或更高级的标题 */
function section(title) {
  const lines = index.split('\n');
  const start = lines.findIndex((l) => /^#{2,4} /.test(l) && l.includes(title));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}
const firstCol = (text) => text.split('\n').filter((l) => /^\|\s*`/.test(l)).flatMap((l) => ticks(l.split('|')[1]));
const sourceText = (sources) => files.filter((f) => sources.some((s) => glob(s).test(f) || f.startsWith(s.endsWith('/') ? s : `${s}/`) || f === s)).map(read).join('\n');
for (const l of cfg.lists || []) {
  const sec = section(l.section);
  if (sec === null) { problems.push(`索引里找不到"${l.section}"这一节（${l.name}）`); continue; }
  let text = sourceText(l.sources);
  if (l.within) text = [...text.matchAll(new RegExp(l.within, 'g'))].map((m) => m[1]).join('\n');
  const found = new Set(l.patterns.flatMap((p) => [...text.matchAll(new RegExp(p, 'g'))].map((m) => m[1])).filter((x) => !(l.ignore || []).includes(x)));
  const have = new Set(l.match === 'firstColumn' ? firstCol(sec) : ticks(sec));
  for (const x of found) if (!have.has(x)) problems.push(`${l.name}：代码里有 ${x}，索引的"${l.section}"没有写`);
  if (l.twoWay) {
    const tokenRe = l.token ? new RegExp(l.token) : null;
    for (const x of firstCol(sec)) {
      if (tokenRe && !tokenRe.test(x)) continue;
      const still = l.twoWay === 'word' ? new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text) : found.has(x);
      if (!still) problems.push(`${l.name}：索引的"${l.section}"写了 ${x}，代码里已经没有了`);
    }
  }
}
finish();

function finish() {
  if (problems.length) {
    console.error(`项目索引检查没有通过（${problems.length} 处）。按下面的提示更新《${INDEX}》《${MAP}》：\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`项目索引检查通过：${scope.length} 个文件，${(cfg.lists || []).length} 类名单`);
  process.exit(0);
}
