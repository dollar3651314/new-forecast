/**
 * 调用 Gemini（Google AI Studio 的 REST 接口，Amos 2026-10-29 选 Gemini：H-5）。只要 JSON 回答；45 秒超时；
 * 思考强度设成 low（2026-10-29 测试版 10 条一批超过 20 秒超时），模型不认这个设置（400）时去掉再试一次。
 * - GEMINI_MODEL 可以写几个模型名（逗号分隔），前一个返回 404（模型名不存在或这个 Key 用不了）就换下一个。
 * - 429（免费额度每分钟 / 每天的上限）抛 GeminiBusy，接口返回 503，插件过一会儿自动再试。
 * - 其他错误抛 GeminiError，detail 只写状态码或"不是 JSON"这类原因，不含 Key（2026-10-29 Amos 测试版报错时看不出原因，加上）。
 */
import type { Env } from './env';

export class GeminiError extends Error {}
export class GeminiBusy extends Error {}
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_MODELS = 'gemini-3.8-flash,gemini-3.6-flash,gemini-flash-latest';

export function modelList(env: Env): string[] {
  const list = (env.GEMINI_MODEL || DEFAULT_MODELS).split(',').map((m) => m.trim()).filter((m) => /^[a-z0-9.-]{3,64}$/.test(m));
  return list.length ? list : DEFAULT_MODELS.split(',');
}

/** 模型偶尔会用 ```json 包住回答，去掉再解析 */
export function parseLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(t);
}

export async function askJson(env: Env, system: string, user: string, fetcher: FetchLike = fetch): Promise<unknown> {
  let last = '';
  for (const model of modelList(env)) {
    const call = async (lowThinking: boolean): Promise<Response> => {
      try {
        return await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { responseMimeType: 'application/json', ...(lowThinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) },
          }),
          signal: AbortSignal.timeout(45_000),
        });
      } catch (e) {
        throw new GeminiError(`${model}: ${(e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network'}`);
      }
    };
    let res = await call(true);
    if (res.status === 400) res = await call(false);
    if (res.status === 404) {
      last = `${model}: HTTP 404`;
      continue;
    }
    if (res.status === 429) throw new GeminiBusy('HTTP 429');
    if (!res.ok) throw new GeminiError(`${model}: HTTP ${res.status}`);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
    const text = body.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
    try {
      return parseLoose(text);
    } catch {
      throw new GeminiError(`${model}: not json`);
    }
  }
  throw new GeminiError(`no model available (${last})`);
}
