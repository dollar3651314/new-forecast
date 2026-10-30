/**
 * 备用 AI：Cloudflare Workers AI（Amos 2026-10-30 选 A）。Gemini 每个模型都超额、超时或出错时才用。
 * - 不用新密钥：wrangler.toml 里的 [ai] 绑定直接用官网所在的 Cloudflare 账号（C132）。
 * - 免费额度每天 10,000 neurons（UTC 0 点重置）；这里按每次回答的 token 数记账，当天到 WORKERS_AI_DAILY_NEURONS（默认 8,000）就停，
 *   不会超出免费额度产生费用（C117）。每次调用前先留出一次最多可能用的量（RESERVE）。
 * - 模型：Qwen3 30B（中文可以、单价最低）；它默认会先"思考"，提示词末尾加 /no_think，回答里的 <think>…</think> 去掉再解析。
 */
import type { Env } from './env';
import { parseLoose } from './gemini';

export const WAI_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
/** 每百万 token 的 neurons（Cloudflare 价格页，2026-10-30） */
const IN_PER_M = 4_625;
const OUT_PER_M = 30_475;
const MAX_OUT = 1_500;
/** 一次最多可能用的 neurons：输入按 8,000 token、输出按 MAX_OUT 算，约 83 */
export const RESERVE = Math.ceil((8_000 * IN_PER_M + MAX_OUT * OUT_PER_M) / 1e6);
export const DEFAULT_DAILY_NEURONS = 8_000;

export class WorkersAiError extends Error {}
/** 今天的额度到上限了 */
export class WorkersAiCap extends Error {}

export interface AiLike {
  run(model: string, input: unknown): Promise<unknown>;
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

export function dailyCap(env: Env): number {
  const n = Number(env.WORKERS_AI_DAILY_NEURONS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 9_500) : DEFAULT_DAILY_NEURONS;
}

export async function usedToday(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare('SELECT neurons FROM ai_usage WHERE day = ?1').bind(utcDay(now)).first<{ neurons: number }>();
  return r?.neurons ?? 0;
}

async function addUsage(env: Env, now: number, neurons: number) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO ai_usage (day, neurons) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET neurons = neurons + ?2').bind(utcDay(now), neurons),
    env.DB.prepare('DELETE FROM ai_usage WHERE day < ?1').bind(utcDay(now - 30 * 24 * 3600_000)),
  ]);
}

/** 从回答里取出文字和 token 数（新旧两种回答格式都认） */
function readResult(r: unknown): { text: string; inTok: number | null; outTok: number | null } {
  const o = (r ?? {}) as { response?: unknown; choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const raw = o.response ?? o.choices?.[0]?.message?.content ?? '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return { text, inTok: o.usage?.prompt_tokens ?? null, outTok: o.usage?.completion_tokens ?? null };
}

/** 回答里可能有 <think>…</think> 或 JSON 前后的说明文字：去掉思考，取第一个 { 到最后一个 } */
export function extractJson(text: string): unknown {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try {
    return parseLoose(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new WorkersAiError('workers-ai: not json');
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      throw new WorkersAiError('workers-ai: not json');
    }
  }
}

export async function askWorkersAi(env: Env, system: string, user: string, now: number): Promise<unknown> {
  const ai = env.AI as AiLike | undefined;
  if (!ai) throw new WorkersAiError('workers-ai: not bound');
  const cap = dailyCap(env);
  if ((await usedToday(env, now)) + RESERVE > cap) throw new WorkersAiCap(`workers-ai: daily cap ${cap}`);
  let r: unknown;
  try {
    r = await ai.run(WAI_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${user}\n/no_think` },
      ],
      max_tokens: MAX_OUT,
    });
  } catch (e) {
    // 失败的调用不一定计费，但保守起见按一次最多可能用的量记账
    await addUsage(env, now, RESERVE);
    throw new WorkersAiError(`workers-ai: ${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  const { text, inTok, outTok } = readResult(r);
  // 没有 token 数时按字数估（中文 1 个字算 1 个 token，偏多）
  const inT = inTok ?? [...system].length + [...user].length;
  const outT = outTok ?? [...text].length;
  await addUsage(env, now, (inT * IN_PER_M + outT * OUT_PER_M) / 1e6);
  return extractJson(text);
}
