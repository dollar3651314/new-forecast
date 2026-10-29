/**
 * 调接口：每次请求 10 秒超时（C81），出错时分清"不存在 / 过期 / 太频繁 / 字段错误 / 网络 / 服务器"（C56：只有确认不存在时才说"链接无效"）。
 */
export type ApiError =
  | { kind: 'notFound' }
  | { kind: 'expired' }
  | { kind: 'rateLimited'; seconds: number }
  | { kind: 'validation'; fields: { field: string; code: string }[] }
  | { kind: 'unauthorized'; code: string }
  | { kind: 'conflict'; code: string }
  | { kind: 'network' }
  | { kind: 'server' };

export type ApiResult<T> = { ok: true; data: T; status: number } | { ok: false; error: ApiError };

export const API_TIMEOUT_MS = 10_000;

export async function api<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<ApiResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      signal: ctrl.signal,
    });
  } catch {
    return { ok: false, error: { kind: 'network' } };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return { ok: true, data: undefined as T, status: 204 };
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    if (res.ok) return { ok: false, error: { kind: 'server' } };
  }
  if (res.ok) return { ok: true, data: body as T, status: res.status };
  const code = typeof body.code === 'string' ? body.code : '';
  if (res.status === 404) return { ok: false, error: { kind: 'notFound' } };
  if (res.status === 410) return { ok: false, error: { kind: 'expired' } };
  if (res.status === 429) return { ok: false, error: { kind: 'rateLimited', seconds: Number(body.cooldownSeconds) || 60 } };
  if (res.status === 400 && Array.isArray(body.fields) && body.fields.length) return { ok: false, error: { kind: 'validation', fields: body.fields as { field: string; code: string }[] } };
  if (res.status === 401) return { ok: false, error: { kind: 'unauthorized', code } };
  if (res.status === 409) return { ok: false, error: { kind: 'conflict', code } };
  return { ok: false, error: { kind: 'server' } };
}

/** 通用的出错文字（i18n 键 + 变量） */
export function errorText(e: ApiError): [string, Record<string, string | number>?] {
  if (e.kind === 'rateLimited') return ['common.rateLimited', { minutes: Math.max(1, Math.ceil(e.seconds / 60)) }];
  if (e.kind === 'network') return ['common.network'];
  return ['common.server'];
}
