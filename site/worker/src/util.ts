/** 小工具：时间、随机串、哈希、打码、开关。参照 forecast main 0caa740 cf/src/util.ts。 */
import { INVITE_ALPHABET } from '../../shared/rules';

/** 时间一律存 UTC 的 ISO 字符串（毫秒，结尾 Z），按字符串比较就是按时间比较 */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 16 字节随机数的十六进制（32 个字符）：确认、退订链接和邀请查看页的私密密钥 */
export function token(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return hex(b);
}

export const TOKEN_RE = /^[0-9a-f]{32}$/;

/** 6 位邀请码（字母表见 shared/rules.ts）；拒绝采样，每个字符等概率 */
export function inviteCode(): string {
  let out = '';
  const n = INVITE_ALPHABET.length;
  const limit = 256 - (256 % n);
  while (out.length < 6) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    for (const x of b) if (x < limit && out.length < 6) out += INVITE_ALPHABET[x % n];
  }
  return out;
}

export async function sha256(v: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
}

/** 邮箱打码：保留第一个字符和域名（a***@example.com） */
export function mask(email: string | null | undefined): string {
  const at = email ? email.indexOf('@') : -1;
  if (!email || at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** 变量是不是"打开"（true / 1 / yes / on，大小写不论）；没填用默认值 */
export function flag(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v.trim() === '') return dflt;
  return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
