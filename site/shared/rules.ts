/**
 * 前后端共用的输入规则（只有这一份，agents C108）：页面（site/web）和 Worker（site/worker）都 import 这里，
 * 同一个输入两边的判断、规范化结果一样。这个文件不能引用别的模块，也不能用 DOM 或 Workers 专有的 API。
 * 测试向量：site/test/shared/rules.test.ts（两边都靠这一组例子）。
 * 参照：forecast main 0caa740 的 web/client/src/lib/emailRule.ts（邮箱规则）、cf/src/attribution.ts（来源参数）。
 */

// ---------- 邮箱 ----------
/** 前后空白去掉以后：本地部分@域名.后缀（后缀至少 2 个字符），不能有空白和多余的 @；最长 254 个字符 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const EMAIL_MAX = 254;

export type EmailError = 'REQUIRED' | 'EMAIL_INVALID';

/** 没有错误返回 null；规范化（去空白、转小写）用 normEmail */
export function validateEmail(raw: unknown): EmailError | null {
  if (typeof raw !== 'string' || raw.trim() === '') return 'REQUIRED';
  const s = raw.trim();
  return s.length <= EMAIL_MAX && EMAIL_RE.test(s) ? null : 'EMAIL_INVALID';
}

export function normEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

// ---------- 语言 ----------
export type Lang = 'zh-TW' | 'zh-CN' | 'en';
export const LANGS: Lang[] = ['zh-TW', 'zh-CN', 'en'];
export const DEFAULT_LANG: Lang = 'zh-TW';

/**
 * 语言规范成 zh-TW / zh-CN / en。简体（zh-CN、zh-SG、zh-Hans）→ zh-CN；其他中文 → zh-TW；英文 → en；
 * 其他语言和认不出的 → 默认繁中（需求单：繁中是默认语言）。
 */
export function normLang(l: unknown): Lang {
  if (typeof l !== 'string') return DEFAULT_LANG;
  const low = l.trim().toLowerCase();
  if (low === 'zh-cn' || low === 'zh-sg' || low.startsWith('zh-hans')) return 'zh-CN';
  if (low.startsWith('zh')) return 'zh-TW';
  if (low === 'en' || low.startsWith('en-')) return 'en';
  return DEFAULT_LANG;
}

// ---------- 来源参数（src、cmp、ref） ----------
/** 每个值只接受 [A-Za-z0-9._~-]，1～64 个字符（前后空白去掉），不合法的当成没有 */
export const ATTR_RE = /^[A-Za-z0-9._~-]{1,64}$/;

export function cleanAttr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return ATTR_RE.test(s) ? s : null;
}

// ---------- 邀请码（M-10） ----------
/** 邀请码：6 个字符，去掉容易看错的 0 O 1 I L */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const INVITE_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** ?ref= 的值是不是邀请码的样子（大小写不论，规范成大写）；不是返回 null */
export function inviteCodeOf(ref: unknown): string | null {
  const c = cleanAttr(ref);
  if (!c) return null;
  const up = c.toUpperCase();
  return INVITE_CODE_RE.test(up) ? up : null;
}

// ---------- 焦点战（M-2，名单页填写） ----------
export const MATCH_LIMITS = { league: 20, title: 40, note: 60, max: 5 };
/** 台湾时间 = UTC+8，没有夏令时 */
export const TW_OFFSET_MS = 8 * 60 * 60 * 1000;

export type MatchFieldError = 'REQUIRED' | 'TOO_LONG' | 'TIME_FORMAT' | 'TIME_INVALID';

export interface MatchInput {
  league: string;
  title: string;
  /** 台湾时间，写法宽松：2026-11-02 10:30、2026/11/2 9:30、11/02 10:30（省略年份）、2026-11-02 9（整点） */
  startsAt: string;
  note?: string;
}

export interface MatchClean {
  league: string;
  title: string;
  /** UTC 的 ISO 字符串（毫秒，结尾 Z） */
  startsAt: string;
  note: string;
}

const TIME_RE = /^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?:\s+|T)(\d{1,2})(?::(\d{2}))?$/;

/**
 * 台湾时间的写法 → UTC ISO。省略年份时取"台湾今天所在的年份"，如果这样算出来的时间比现在早 60 天以上，算明年（跨年时 12 月填 1 月的比赛）。
 * 返回错误码：TIME_FORMAT（写法认不出）、TIME_INVALID（日期不存在，例如 2 月 30 日、25:00）。
 */
export function parseTaiwanTime(raw: string, now: number): { ok: true; iso: string } | { ok: false; code: 'REQUIRED' | 'TIME_FORMAT' | 'TIME_INVALID' } {
  const s = raw.trim().replace(/：/g, ':').replace(/／/g, '/');
  if (!s) return { ok: false, code: 'REQUIRED' };
  const m = TIME_RE.exec(s);
  if (!m) return { ok: false, code: 'TIME_FORMAT' };
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const make = (y: number) => Date.UTC(y, month - 1, day, hour, minute) - TW_OFFSET_MS;
  const valid = (y: number) => {
    const d = new Date(Date.UTC(y, month - 1, day, hour, minute));
    return d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day && hour < 24 && minute < 60;
  };
  let year: number;
  if (m[1]) {
    year = Number(m[1]);
  } else {
    year = new Date(now + TW_OFFSET_MS).getUTCFullYear();
    if (valid(year) && make(year) < now - 60 * 24 * 60 * 60 * 1000) year += 1;
  }
  if (month < 1 || month > 12 || !valid(year)) return { ok: false, code: 'TIME_INVALID' };
  return { ok: true, iso: new Date(make(year)).toISOString() };
}

/** UTC ISO → 台湾时间的标准写法 2026-11-02 10:30（名单页表格、编辑框用） */
export function formatTaiwanTime(iso: string): string {
  const d = new Date(Date.parse(iso) + TW_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 检查并规范一场焦点战：**每个字段都检查完**再返回（一次提示全部错误，C56），错误按字段给出。
 * 文字字段去掉前后空白；长度按字符数（中文一个字算 1）。
 */
export function validateMatch(input: Partial<Record<keyof MatchInput, unknown>>, now: number): { ok: true; value: MatchClean } | { ok: false; errors: Partial<Record<keyof MatchInput, MatchFieldError>> } {
  const errors: Partial<Record<keyof MatchInput, MatchFieldError>> = {};
  const text = (k: 'league' | 'title' | 'note', required: boolean): string => {
    const v = typeof input[k] === 'string' ? (input[k] as string).trim() : '';
    if (!v && required) errors[k] = 'REQUIRED';
    else if ([...v].length > MATCH_LIMITS[k]) errors[k] = 'TOO_LONG';
    return v;
  };
  const league = text('league', true);
  const title = text('title', true);
  const note = text('note', false);
  let startsAt = '';
  const t = parseTaiwanTime(typeof input.startsAt === 'string' ? input.startsAt : '', now);
  if (t.ok) startsAt = t.iso;
  else errors.startsAt = t.code;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { league, title, startsAt, note } };
}

/** 首页只显示还没开赛、或开赛不到 3 小时的焦点战（比赛打完自然下架；名单页会写明哪些已经不显示，C49） */
export const MATCH_SHOW_AFTER_START_MS = 3 * 60 * 60 * 1000;

export function matchVisible(startsAtIso: string, now: number): boolean {
  return Date.parse(startsAtIso) + MATCH_SHOW_AFTER_START_MS > now;
}

// ---------- 怎么玩的算例（M-3） ----------
/**
 * 彩池算例：两边奖池、押中的一边、你押的金额、抽成比例 → 你拿回多少、整个奖池回到玩家手上的比例。
 * 首页"怎么玩"的算例数字来自这里（文案里的数字由测试核对，site/test/web/content.test.ts）。
 */
export function poolExample(winPool: number, losePool: number, stake: number, feeRate = 0.05) {
  const fee = losePool * feeRate;
  const share = losePool - fee;
  const payout = stake + (share * stake) / winPool;
  const total = winPool + losePool;
  return { fee, share, payout: Math.round(payout * 100) / 100, returnRate: (total - fee) / total };
}
