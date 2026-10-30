/**
 * 每个模型每天的用量和我们设的上限（副驾驶 0.3，Amos 2026-10-30；D-3：Gemini 按次数设上限，token 也记下来给 Amos 看）。
 * - Gemini 的真实免费额度 Google 不提供查询接口：这里只数我们自己发了几次、用了多少 token；Google 回 429 时记下来，后台标"Google 说额度用完"。
 * - 一天怎么算跟着各家的重置时间：Gemini 按美国太平洋时间半夜，Workers AI 按 UTC 0 点（台湾早上 8 点）。
 * - 上限存在 settings 表（后台"用量和限额"页改）；Gemini 默认每个模型每天 200 次，Workers AI 默认 8000 neurons、最多 9500（免费额度 10000，C117）。
 */
import type { Env } from './env';

export const WAI_KEY = 'workers-ai';
export const GEMINI_DEFAULT_CAP = 200;
export const GEMINI_MAX_CAP = 10_000;
export const WAI_DEFAULT_CAP = 8_000;
export const WAI_MAX_CAP = 9_500;

/** 美国太平洋时间的年月日时分秒 → 当地时间当成 UTC 的毫秒数 */
function laLocal(now: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
}
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
export const pacificDay = (now: number) => new Date(laLocal(now)).toISOString().slice(0, 10);
export const dayFor = (model: string, now: number) => (model === WAI_KEY ? utcDay(now) : pacificDay(now));

/** 下一次重置的时间（毫秒） */
export function nextReset(model: string, now: number): number {
  if (model === WAI_KEY) return Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
  const local = laLocal(now);
  const offset = local - Math.floor(now / 1000) * 1000; // 太平洋时间比 UTC 慢多少（负数）
  const d = new Date(local);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - offset;
}

export async function getCap(env: Env, model: string): Promise<number> {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1').bind('cap:' + model).first<{ value: string }>();
  const v = Number(r?.value);
  if (model === WAI_KEY) {
    const fallback = Number(env.WORKERS_AI_DAILY_NEURONS);
    const n = Number.isFinite(v) && v > 0 ? v : Number.isFinite(fallback) && fallback > 0 ? fallback : WAI_DEFAULT_CAP;
    return Math.min(n, WAI_MAX_CAP);
  }
  return Number.isFinite(v) && v > 0 ? Math.min(v, GEMINI_MAX_CAP) : GEMINI_DEFAULT_CAP;
}

export async function usedReq(env: Env, model: string, now: number): Promise<number> {
  const r = await env.DB.prepare('SELECT req FROM model_usage WHERE day = ?1 AND model = ?2').bind(dayFor(model, now), model).first<{ req: number }>();
  return r?.req ?? 0;
}

/** 记一次请求（不管成功与否都算一次，Google 也是这样算的） */
export async function recordUse(env: Env, model: string, now: number, u: { status: number; tokIn?: number; tokOut?: number }) {
  await env.DB.prepare(
    'INSERT INTO model_usage (day, model, req, tok_in, tok_out, last_status, last_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6) ' +
      'ON CONFLICT (day, model) DO UPDATE SET req = req + 1, tok_in = tok_in + ?3, tok_out = tok_out + ?4, last_status = ?5, last_at = ?6',
  )
    .bind(dayFor(model, now), model, Math.max(0, Math.round(u.tokIn ?? 0)), Math.max(0, Math.round(u.tokOut ?? 0)), u.status, now)
    .run();
}

export interface UsageRow { model: string; label: string; unit: '次' | 'neurons'; req: number; tokIn: number; tokOut: number; used: number; cap: number; max: number; state: 'ok' | 'google_429' | 'our_cap' | 'error'; stateText: string; resetAt: number }

export async function usageReport(env: Env, now: number, geminiModels: string[], waiUsed: number, waiBound: boolean): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  const models = [...geminiModels, ...(waiBound ? [WAI_KEY] : [])];
  for (const model of models) {
    const r = await env.DB.prepare('SELECT req, tok_in, tok_out, last_status FROM model_usage WHERE day = ?1 AND model = ?2').bind(dayFor(model, now), model).first<{ req: number; tok_in: number; tok_out: number; last_status: number | null }>();
    const cap = await getCap(env, model);
    const wai = model === WAI_KEY;
    const used = wai ? Math.round(waiUsed) : (r?.req ?? 0);
    let state: UsageRow['state'] = 'ok';
    let stateText = '正常';
    if (used >= cap) { state = 'our_cap'; stateText = '到了我们设的上限，今天先跳过'; }
    else if (r?.last_status === 429) { state = 'google_429'; stateText = 'Google 说额度用完（429）'; }
    else if (r?.last_status != null && r.last_status !== 200) { state = 'error'; stateText = r.last_status === 0 ? '最近一次超时或连不上' : `最近一次出错（${r.last_status}）`; }
    rows.push({
      model, label: wai ? '备用 AI · Workers AI（qwen3-30b）' : model, unit: wai ? 'neurons' : '次',
      req: r?.req ?? 0, tokIn: r?.tok_in ?? 0, tokOut: r?.tok_out ?? 0, used, cap, max: wai ? WAI_MAX_CAP : GEMINI_MAX_CAP, state, stateText, resetAt: nextReset(model, now),
    });
  }
  return rows;
}

/** 后台保存上限：全部合法才保存，返回不合法的原因 */
export async function saveCaps(env: Env, now: number, caps: Record<string, unknown>, allowed: string[]): Promise<string[]> {
  const bad: string[] = [];
  const ok: [string, number][] = [];
  for (const [model, v] of Object.entries(caps)) {
    if (!allowed.includes(model)) { bad.push(`不认识的模型：${model.slice(0, 40)}`); continue; }
    const max = model === WAI_KEY ? WAI_MAX_CAP : GEMINI_MAX_CAP;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > max) bad.push(`${model === WAI_KEY ? 'Workers AI' : model} 要在 1～${max.toLocaleString('en-US')} 之间${model === WAI_KEY ? '（超过 9,500 可能产生费用）' : ''}`);
    else ok.push([model, n]);
  }
  if (bad.length) return bad;
  if (ok.length) await env.DB.batch(ok.map(([m, n]) => env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3').bind('cap:' + m, String(n), now)));
  return [];
}
