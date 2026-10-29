/**
 * 接口的返回格式和读请求的小工具。出错时一律 `{code, message, fields:[{field, code}]}`（message 只给日志和排查看，页面按 code 显示自己的文案，C6）；
 * 限次时多一个 cooldownSeconds。每个接口都带安全头（静态资源的安全头在 site/web/public/_headers）。
 * 参照：forecast main 0caa740 cf/src/http.ts。
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=86400',
};

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  new Headers(headers).forEach((v, k) => h.append(k, v));
  return new Response(JSON.stringify(body), { status, headers: h });
}

export interface FieldError {
  field: string;
  code: string;
}

export function error(status: number, code: string, message: string, fields: FieldError[] = [], extra: Record<string, unknown> = {}, headers: HeadersInit = {}): Response {
  return json({ code, message, fields, ...extra }, status, headers);
}

export const notFound = () => error(404, 'NOT_FOUND', 'not found');

export function rateLimited(retryAfter: number, code = 'RATE_LIMITED'): Response {
  return error(429, code, 'too many requests', [], { cooldownSeconds: retryAfter }, { 'Retry-After': String(retryAfter) });
}

/**
 * 写接口只接受 JSON（浏览器跨站提交的表单发不出这种请求），Origin 不是本站时 403；正文最大 16 KB。
 */
export async function readJson(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin) return { ok: false, res: error(403, 'FORBIDDEN', 'cross-origin request') };
  const ct = (req.headers.get('Content-Type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) return { ok: false, res: error(400, 'BAD_REQUEST', 'expect application/json') };
  try {
    const text = await req.text();
    if (text.length > 16 * 1024) return { ok: false, res: error(400, 'BAD_REQUEST', 'body too large') };
    const body: unknown = text ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, res: error(400, 'BAD_REQUEST', 'expect a JSON object') };
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, res: error(400, 'BAD_REQUEST', 'invalid JSON') };
  }
}

/** 访客 IP：Cloudflare 填的 CF-Connecting-IP（客户端改不了）；本机测试没有时用空串 */
export function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') || '';
}

export function cookie(req: Request, name: string): string | null {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  new Headers(headers).forEach((v, k) => h.append(k, v));
  return new Response(body, { status, headers: h });
}

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
