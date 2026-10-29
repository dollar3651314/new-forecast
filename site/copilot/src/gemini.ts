/**
 * 调用 Gemini（Google AI Studio 的 REST 接口，Amos 2026-10-29 选 Gemini：H-5）。只要 JSON 回答；20 秒超时；
 * 出错时抛 GeminiError（接口返回 502 给插件，插件显示"团队暂时没回应"）。Key 只在请求头里，不写进日志。
 */
import type { Env } from './env';

export class GeminiError extends Error {}
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function askJson(env: Env, system: string, user: string, fetcher: FetchLike = fetch): Promise<unknown> {
  const model = (env.GEMINI_MODEL || 'gemini-flash-latest').trim();
  if (!/^[a-z0-9.-]{3,64}$/.test(model)) throw new GeminiError('model name');
  const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new GeminiError(`HTTP ${res.status}`);
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError('not json');
  }
}
