/**
 * 备用 AI：Cloudflare Workers AI（Amos 2026-10-30 选 A）。Gemini 每个模型都超额、超时或出错时才用。
 * - 不用新密钥：wrangler.toml 里的 [ai] 绑定直接用官网所在的 Cloudflare 账号（C132）。
 * - 免费额度每天 10,000 neurons（UTC 0 点重置）；这里按每次回答的 token 数记账，当天到上限（后台设，默认 8,000，最多 9,500，usage.ts）就停，
 *   不会超出免费额度产生费用（C117）。每次调用前先留出一次最多可能用的量（RESERVE）。
 * - 模型：Qwen3 30B（中文可以、单价最低）；它默认会先"思考"，提示词末尾加 /no_think，回答里的 <think>…</think> 去掉再解析。
 */
import type { Env } from './env';
import { parseLoose } from './gemini';
import { getCap, recordUse, WAI_KEY } from './usage';

export const WAI_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
/** 每百万 token 的 neurons（Cloudflare 价格页，2026-10-30） */
const IN_PER_M = 4_625;
const OUT_PER_M = 30_475;
const MAX_OUT = 2_000;
/** 一次最多可能用的 neurons：输入按 8,000 token、输出按 MAX_OUT 算，约 98 */
export const RESERVE = Math.ceil((8_000 * IN_PER_M + MAX_OUT * OUT_PER_M) / 1e6);

export class WorkersAiError extends Error {}
/** 今天的额度到上限了 */
export class WorkersAiCap extends Error {}

export interface AiLike {
  run(model: string, input: unknown): Promise<unknown>;
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** 每天上限：后台"用量和限额"页设的值，没设时用 WORKERS_AI_DAILY_NEURONS，最多 9500（usage.ts） */
export const dailyCap = (env: Env): Promise<number> => getCap(env, WAI_KEY);

export async function usedToday(env: Env, now: number): Promise<number> {
  const r = await env.DB.prepare('SELECT neurons FROM ai_usage WHERE day = ?1').bind(utcDay(now)).first<{ neurons: number }>();
  return r?.neurons ?? 0;
}

async function addUsage(env: Env, now: number, neurons: number) {
  // 记录一直保留（D-4 选 B）
  await env.DB.prepare('INSERT INTO ai_usage (day, neurons) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET neurons = neurons + ?2').bind(utcDay(now), neurons).run();
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
    // 带上回答的开头和结尾几个字，看得出是被截断还是答非所问（2026-10-30 测试版出现过一次）
    const bad = () => new WorkersAiError(`Workers AI 回答不是 JSON（${t.length} 字：${t.slice(0, 40).replace(/\s+/g, ' ')}…${t.slice(-20).replace(/\s+/g, ' ')}）`);
    if (a < 0 || b <= a) throw bad();
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      try {
        return JSON.parse(repairBrackets(t.slice(a)));
      } catch {
        throw bad();
      }
    }
  }
}

/**
 * 补齐括号：Qwen 有时少写一个 ]（例如 "reasons":["…"}]} ），或者回答被截断少了结尾（2026-10-30 Amos 两个窗口一起跑时日志里出现）。
 * 在字符串外面按顺序检查 { [ 和 } ]：遇到对不上的右括号，先补上该有的右括号；最后补齐没关上的。只修括号，不改内容。
 */
export function repairBrackets(s: string): string {
  const stack: string[] = [];
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      while (stack.length && stack[stack.length - 1] !== ch) out += stack.pop();
      if (!stack.length) break; // 多出来的右括号：后面都不要
      stack.pop();
      out += ch;
      if (!stack.length) return out;
      continue;
    }
    out += ch;
  }
  if (inStr) out += '"';
  return out + stack.reverse().join('');
}

export async function askWorkersAi(env: Env, system: string, user: string, now: number): Promise<unknown> {
  const ai = env.AI as AiLike | undefined;
  if (!ai) throw new WorkersAiError('Workers AI 没有绑定');
  const cap = await dailyCap(env);
  if ((await usedToday(env, now)) + RESERVE > cap) throw new WorkersAiCap(`Workers AI 今天用到 ${cap} 上限（台湾早上 8 点重置）`);
  let r: unknown;
  try {
    r = await ai.run(WAI_MODEL, {
      messages: [
        // Qwen 偶尔漏括号：再强调一次只要合法 JSON（括号漏了还有 repairBrackets 兜底）
        { role: 'system', content: `${system}\n\n【输出】只输出一个合法的 JSON 对象，不要任何说明文字；每个数组都要用 ] 关上，字符串数组里每一项都用双引号。` },
        { role: 'user', content: `${user}\n/no_think` },
      ],
      max_tokens: MAX_OUT,
    });
  } catch (e) {
    // 失败的调用不一定计费，但保守起见按一次最多可能用的量记账
    await addUsage(env, now, RESERVE);
    await recordUse(env, WAI_KEY, now, { status: 0 });
    throw new WorkersAiError(`Workers AI 出错：${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  const { text, inTok, outTok } = readResult(r);
  // 没有 token 数时按字数估（中文 1 个字算 1 个 token，偏多）
  const inT = inTok ?? [...system].length + [...user].length;
  const outT = outTok ?? [...text].length;
  await addUsage(env, now, (inT * IN_PER_M + outT * OUT_PER_M) / 1e6);
  await recordUse(env, WAI_KEY, now, { status: 200, tokIn: inT, tokOut: outT });
  return extractJson(text);
}
