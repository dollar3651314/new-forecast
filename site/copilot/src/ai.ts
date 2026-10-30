/**
 * 先问 Gemini（H-5），Gemini 每个模型都超额、超时或出错时换备用 AI（Workers AI，2026-10-30 Amos 选 A）。
 * 返回值带 engine，草稿上标出是哪个 AI 写的（备用 AI 写的中文可能差一点，插件和后台加标记）。
 * 两个都用不了：Gemini 是超额或备用 AI 是额度用完 → GeminiBusy（503，插件过一会儿再试）；其他 → GeminiError（502 + 原因）。
 */
import type { Env } from './env';
import { askJson as askGemini, diagnose as diagnoseGemini, GeminiBusy, GeminiError, type FetchLike } from './gemini';
import { askWorkersAi, dailyCap, usedToday, WAI_MODEL, WorkersAiCap } from './workers-ai';

export type Engine = 'gemini' | 'workers-ai';

export async function ask(env: Env, system: string, user: string, now: number, fetcher?: FetchLike): Promise<{ data: unknown; engine: Engine }> {
  let first: Error;
  try {
    return { data: await askGemini(env, system, user, fetcher), engine: 'gemini' };
  } catch (e) {
    if (!(e instanceof GeminiBusy || e instanceof GeminiError)) throw e;
    first = e;
  }
  if (!env.AI) throw first;
  try {
    const data = await askWorkersAi(env, system, user, now);
    console.log(JSON.stringify({ event: 'copilot.fallback_workers_ai', reason: first.message }));
    return { data, engine: 'workers-ai' };
  } catch (e) {
    if (first instanceof GeminiBusy || e instanceof WorkersAiCap) throw new GeminiBusy(`${first.message}；${(e as Error).message}`);
    throw new GeminiError(`${first.message}；${(e as Error).message}`);
  }
}

/** 设置页"测试 AI"：每个 Gemini 模型一行，再加备用 AI 一行（带今天用了多少额度） */
export async function diagnose(env: Env, now: number, fetcher?: FetchLike): Promise<{ model: string; ok: boolean; ms: number; detail: string }[]> {
  const out = await diagnoseGemini(env, fetcher);
  if (!env.AI) return [...out, { model: '备用 AI（Workers AI）', ok: false, ms: 0, detail: '没有绑定' }];
  const t0 = Date.now();
  try {
    await askWorkersAi(env, '只回答 JSON。', '回答 {"ok":true}', now);
    out.push({ model: `备用 AI ${WAI_MODEL.split('/').pop()}`, ok: true, ms: Date.now() - t0, detail: `OK（今天已用 ${Math.round(await usedToday(env, now))} / ${dailyCap(env)}）` });
  } catch (e) {
    out.push({ model: `备用 AI ${WAI_MODEL.split('/').pop()}`, ok: false, ms: Date.now() - t0, detail: (e as Error).message });
  }
  return out;
}
