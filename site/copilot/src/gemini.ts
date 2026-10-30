/**
 * 调用 Gemini（Google AI Studio 的 REST 接口，Amos 2026-10-29 选 Gemini：H-5）。只要 JSON 回答；每个模型 20 秒超时，超时或 5xx 换下一个模型
 * （2026-10-30 测试版：gemini-3.8-flash 2 条帖子 45 秒都没回答）；
 * 思考强度设成 low（2026-10-29 测试版 10 条一批超过 20 秒超时），模型不认这个设置（400）时去掉再试一次。
 * - GEMINI_MODEL 可以写几个模型名（逗号分隔），前一个返回 404（模型名不存在或这个 Key 用不了）就换下一个。
 * - 429（免费额度每分钟 / 每天的上限，按模型算）换下一个模型；全都 429 才抛 GeminiBusy，接口返回 503，插件过一会儿自动再试。
 * - 其他错误抛 GeminiError，detail 只写状态码或"不是 JSON"这类原因，不含 Key（2026-10-29 Amos 测试版报错时看不出原因，加上）。
 */
import type { Env } from './env';
import { getCap, recordUse, usedReq } from './usage';

export class GeminiError extends Error {}
export class GeminiBusy extends Error {}
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// 2026-10-30 测试 AI：3.8-flash 和 flash-latest 免费额度 429，只有 3.6-flash 正常 → 3.6 放第一个
export const DEFAULT_MODELS = 'gemini-3.6-flash,gemini-3.8-flash,gemini-flash-latest';

export function modelList(env: Env): string[] {
  const list = (env.GEMINI_MODEL || DEFAULT_MODELS).split(',').map((m) => m.trim()).filter((m) => /^[a-z0-9.-]{3,64}$/.test(m));
  return list.length ? list : DEFAULT_MODELS.split(',');
}

/** 模型偶尔会用 ```json 包住回答，去掉再解析 */
export function parseLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(t);
}

export const PER_MODEL_MS = 20_000;

/** 调一次某个模型（low：思考强度设成 low）；网络出错或超时抛 GeminiError */
async function callModel(env: Env, model: string, system: string, user: string, low: boolean, fetcher: FetchLike): Promise<Response> {
  try {
    return await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', ...(low ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) },
      }),
      signal: AbortSignal.timeout(PER_MODEL_MS),
    });
  } catch (e) {
    throw new GeminiError((e as Error)?.name === 'TimeoutError' ? `${PER_MODEL_MS / 1000} 秒没回答` : '连不上');
  }
}

type GeminiBody = { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
/** 记一次 Gemini 请求：状态和 token（回答里的 usageMetadata；思考用的 token 算在输出里） */
async function record(env: Env, model: string, now: number, status: number, body?: GeminiBody) {
  const u = body?.usageMetadata;
  await recordUse(env, model, now, { status, tokIn: u?.promptTokenCount, tokOut: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) });
}

/** 诊断：每个模型发一个很小的请求，报状态和用时（设置页"测试 AI"，不含 Key） */
export async function diagnose(env: Env, fetcher: FetchLike = fetch, now = Date.now()): Promise<{ model: string; ok: boolean; ms: number; detail: string }[]> {
  const out = [];
  for (const model of modelList(env)) {
    const t0 = Date.now();
    try {
      let res = await callModel(env, model, '只回答 JSON。', '回答 {"ok":true}', true, fetcher);
      if (res.status === 400) res = await callModel(env, model, '只回答 JSON。', '回答 {"ok":true}', false, fetcher);
      const body = res.ok ? await res.text() : (await res.text()).slice(0, 200);
      let parsed: GeminiBody | undefined;
      try { parsed = res.ok ? (JSON.parse(body) as GeminiBody) : undefined; } catch { /* 只是拿不到 token 数 */ }
      await record(env, model, now, res.status, parsed);
      out.push({ model, ok: res.ok, ms: Date.now() - t0, detail: res.ok ? 'OK' : `HTTP ${res.status} ${body.replace(/\s+/g, ' ').replace(/AIza[0-9A-Za-z_-]+/g, '***').slice(0, 160)}` });
    } catch (e) {
      await record(env, model, now, 0);
      out.push({ model, ok: false, ms: Date.now() - t0, detail: (e as Error).message });
    }
  }
  return out;
}

/**
 * 每个模型失败的原因用中文写进 tried（2026-10-30 Amos：到上限时要说清楚是哪个模型、什么原因，不要只说"团队忙"）。
 * 全都超额 → GeminiBusy；其他 → GeminiError；message 是每个模型的原因（不含 Key）。
 */
export async function askJson(env: Env, system: string, user: string, fetcher: FetchLike = fetch, now = Date.now()): Promise<unknown> {
  const tried: string[] = [];
  let busy = false;
  for (const model of modelList(env)) {
    // 到了 Amos 在后台设的每天上限（0.3，D-3）：今天先跳过这个模型
    const cap = await getCap(env, model);
    if ((await usedReq(env, model, now)) >= cap) {
      busy = true;
      tried.push(`${model} 到了我们设的上限（每天 ${cap} 次）`);
      continue;
    }
    const call = (lowThinking: boolean) => callModel(env, model, system, user, lowThinking, fetcher);
    let res: Response;
    try {
      res = await call(true);
      if (res.status === 400) res = await call(false);
    } catch (e) {
      // 超时、网络出错：换下一个模型
      await record(env, model, now, 0);
      tried.push(`${model} ${(e as Error).message}`);
      continue;
    }
    if (!res.ok) await record(env, model, now, res.status);
    if (res.status === 404) {
      tried.push(`${model} 这个 Key 用不了（404）`);
      continue;
    }
    if (res.status >= 500) {
      tried.push(`${model} Google 那边出错（${res.status}）`);
      continue;
    }
    if (res.status === 429) {
      // 免费额度按模型算：这个模型超额就换下一个；全都超额才算"忙"（2026-10-30 测试版一直"团队忙"）
      busy = true;
      tried.push(`${model} 免费额度用完（429）`);
      continue;
    }
    if (!res.ok) throw new GeminiError([...tried, `${model} 出错（HTTP ${res.status}）`].join('；'));
    const body = (await res.json()) as GeminiBody;
    await record(env, model, now, res.status, body);
    const text = body.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
    try {
      return parseLoose(text);
    } catch {
      throw new GeminiError([...tried, `${model} 回答不是 JSON`].join('；'));
    }
  }
  if (busy) throw new GeminiBusy(tried.join('；'));
  throw new GeminiError(tried.join('；') || '没有可用的模型');
}
