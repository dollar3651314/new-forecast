#!/usr/bin/env node
// 公司运营仪表盘的上报脚本（agents 公司平台/技术方案-运营仪表盘.md 第二、五节；PR 5 new-forecast、PR 6 Marketing）。
// 不依赖任何库，Node 22。new-forecast 和 Marketing 两个仓库里内容完全相同，只用环境变量 COMPANY_SOURCE 区分。
// 由 .github/workflows/company.yml 在推送到 main、PR 开 / 关 / 重开 / 改标题时运行；不设定时任务（Amos B-6）。
//
// 做的事：用 Actions 自带的 GITHUB_TOKEN（本机 --dry-run 没有时匿名读，只适用公开仓库）读本仓库（GITHUB_REPOSITORY）——
//   ① 标题含【要你决定】的 open PR → {kind:'prs', key:'', payload:{items:[{number,title,url,days}]}}
//   ② main 最近一次 CI（COMPANY_CI_WORKFLOW，默认 ci.yml）的结论和链接；最近一次 deploy job（COMPANY_DEPLOY_JOB，默认 deploy）
//      成功的那次运行的提交号和完成时间 → {kind:'ci', key:'', payload:{conclusion,url,sha,at,note}}
//      （页面"最近部署"一列显示 sha · at；main 最近一次 CI 的提交号和时间写在 note 里）
//   读 GitHub 失败的那一块发 status = error（Marketing 保留上次成功的内容，页面显示"解析失败：原因"），另一块照常。
// 再 POST 到 Marketing 的 /api/company/ingest（Bearer COMPANY_INGEST_TOKEN；地址默认正式版，COMPANY_INGEST_URL 可改）。
//   - 没有 COMPANY_INGEST_TOKEN：打印"跳过：没有 COMPANY_INGEST_TOKEN"，退出 0（没配置不是故障，C103）
//   - 429（每个 source 每分钟最多 6 次）：等 60 秒重试一次
//   - 其他非 2xx：打印响应，退出 1
//   - --dry-run：只打印要发的 JSON，不发（不需要 COMPANY_INGEST_TOKEN）
import { pathToFileURL } from 'node:url';

export const DECIDE = '【要你决定】';
export const DEFAULT_INGEST_URL = 'https://marketing.quickcome.online/api/company/ingest';
const DAY_MS = 24 * 3600_000;

/** GitHub 的结论 → 仪表盘的 conclusion（success / failure / cancelled / running / none / off） */
export function conclusionOf(run) {
  if (!run) return 'none';
  if (run.status !== 'completed') return 'running';
  if (run.conclusion === 'success') return 'success';
  if (run.conclusion === 'cancelled' || run.conclusion === 'skipped' || run.conclusion === 'stale') return 'cancelled';
  return 'failure';
}

/** 毫秒时间戳 → 台湾时间 "2026-11-01 20:00"（页面给 Amos 看） */
export function twTime(ms) {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

function ghClient(env, fetchImpl) {
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  return async (path) => {
    const r = await fetchImpl(`${api}${path}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'company-report', ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
    });
    if (!r.ok) throw new Error(`GitHub ${path.split('?')[0]} 返回 ${r.status}`);
    return r.json();
  };
}

/** 含【要你决定】的 open PR */
export async function prsBlock(get, repo, now) {
  const list = await get(`/repos/${repo}/pulls?state=open&per_page=100&sort=created&direction=asc`);
  const items = list
    .filter((p) => typeof p.title === 'string' && p.title.includes(DECIDE))
    .map((p) => ({ number: p.number, title: p.title.slice(0, 200), url: p.html_url, days: Math.max(0, Math.floor((now - Date.parse(p.created_at)) / DAY_MS)) }));
  return { kind: 'prs', key: '', payload: { items }, source_at: now };
}

/** main 最近一次 CI + 最近一次部署成功 */
export async function ciBlock(get, repo, now, { workflow = 'ci.yml', deployJob = 'deploy', maxJobLookups = 10 } = {}) {
  const data = await get(`/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=main&per_page=30&exclude_pull_requests=true`);
  // 只看 main 自己的运行（推送、手动），不看 PR 的
  const runs = (data.workflow_runs || []).filter((r) => r.head_branch === 'main' && r.event !== 'pull_request');
  const last = runs[0];
  const payload = { conclusion: conclusionOf(last) };
  const notes = [];
  if (last) {
    payload.url = last.html_url;
    notes.push(`main 最近一次：${String(last.head_sha).slice(0, 7)} · ${twTime(Date.parse(last.run_started_at || last.created_at))}`);
  }
  // 最近一次部署成功：从新到旧找整次运行成功的，看 deploy job 是不是成功（不是跳过）
  let deploy = null;
  let looked = 0;
  for (const r of runs) {
    if (r.status !== 'completed' || r.conclusion !== 'success') continue;
    if (looked++ >= maxJobLookups) break;
    const jobs = await get(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`);
    const job = (jobs.jobs || []).find((j) => j.name === deployJob && j.conclusion === 'success');
    if (job) { deploy = { sha: String(r.head_sha).slice(0, 40), at: Date.parse(job.completed_at || r.updated_at) }; break; }
  }
  if (deploy) { payload.sha = deploy.sha; payload.at = deploy.at; } else notes.push(last ? '最近没找到成功的部署' : 'main 还没有 CI 运行');
  payload.note = notes.join('；').slice(0, 200);
  return { kind: 'ci', key: '', payload, source_at: now };
}

/** 组成要推送的 JSON：{source, blocks}；读 GitHub 失败的块写成 status = error */
export async function buildReport({ env = process.env, fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const source = (env.COMPANY_SOURCE || '').trim();
  const repo = (env.GITHUB_REPOSITORY || '').trim();
  if (!source) throw new Error('缺少 COMPANY_SOURCE（new-forecast / marketing）');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('缺少 GITHUB_REPOSITORY（owner/repo）');
  const get = ghClient(env, fetchImpl);
  const opts = { workflow: env.COMPANY_CI_WORKFLOW || 'ci.yml', deployJob: env.COMPANY_DEPLOY_JOB || 'deploy' };
  const safe = async (kind, fn) => {
    try { return await fn(); } catch (e) { return { kind, key: '', status: 'error', error: `读 GitHub 失败：${e.message}`.slice(0, 300), source_at: now }; }
  };
  const blocks = [await safe('prs', () => prsBlock(get, repo, now)), await safe('ci', () => ciBlock(get, repo, now, opts))];
  return { source, blocks };
}

/** 发到 /api/company/ingest；429 等 60 秒重试一次。返回退出码 */
export async function send(report, { env = process.env, fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, error = console.error } = {}) {
  const url = (env.COMPANY_INGEST_URL || '').trim() || DEFAULT_INGEST_URL;
  const post = () => fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${env.COMPANY_INGEST_TOKEN.trim()}`, 'content-type': 'application/json' }, body: JSON.stringify(report) });
  let r = await post();
  if (r.status === 429) {
    log('太频繁（429），等 60 秒重试一次');
    await sleep(60_000);
    r = await post();
  }
  const text = await r.text();
  if (!r.ok) { error(`上报失败：${r.status} ${text.slice(0, 2000)}`); return 1; }
  log(`上报成功：${r.status} ${text.slice(0, 500)}`);
  return 0;
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetch: fetchImpl = globalThis.fetch, sleep, log = console.log, error = console.error, now = Date.now() } = {}) {
  const dry = argv.includes('--dry-run');
  if (!dry && !(env.COMPANY_INGEST_TOKEN || '').trim()) { log('跳过：没有 COMPANY_INGEST_TOKEN'); return 0; }
  let report;
  try { report = await buildReport({ env, fetch: fetchImpl, now }); } catch (e) { error(`上报失败：${e.message}`); return 1; }
  if (dry) { log(JSON.stringify(report, null, 2)); return 0; }
  for (const b of report.blocks) if (b.status === 'error') error(`${b.kind}：${b.error}`);
  return send(report, { env, fetch: fetchImpl, sleep, log, error });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
