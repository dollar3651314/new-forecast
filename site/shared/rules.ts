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

// ---------- 焦点战（M-2，名单页填写或批量导入） ----------
export const MATCH_LIMITS = { league: 20, home: 20, away: 20, note: 60, max: 5 };
/** 联赛下拉的选项（名单页）；选"其他"时另填联赛名 */
export const MATCH_LEAGUES = ['NBA', 'MLB', '英超', '西甲', '歐冠', '中職'] as const;
export const OTHER_LEAGUE = '其他';
/** 台湾时间 = UTC+8，没有夏令时 */
export const TW_OFFSET_MS = 8 * 60 * 60 * 1000;

export type MatchFieldError = 'REQUIRED' | 'TOO_LONG' | 'TIME_FORMAT' | 'TIME_INVALID';
export type MatchField = 'league' | 'home' | 'away' | 'startsAt' | 'note';

export interface MatchInput {
  league: string;
  /** 主队 */
  home: string;
  /** 客队 */
  away: string;
  /** 台湾时间，写法宽松：2026-11-02 10:30、2026-11-02T10:30（日期时间选择器）、2026/11/2 9:30、11/02 10:30（省略年份）、2026-11-02 9（整点） */
  startsAt: string;
  note?: string;
}

export interface MatchClean {
  league: string;
  home: string;
  away: string;
  /** 首页显示的对战：主队 vs 客队 */
  title: string;
  /** UTC 的 ISO 字符串（毫秒，结尾 Z） */
  startsAt: string;
  note: string;
}

const TIME_RE = /^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?:\s+|T)(\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?$/;

/**
 * 台湾时间的写法 → UTC ISO。省略年份时取"台湾今天所在的年份"，如果这样算出来的时间比现在早 60 天以上，算明年（跨年时 12 月填 1 月的比赛）。
 * 秒可以有（Excel 里的"2026/11/2 10:30:00"），但不计。
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

/** UTC ISO → 台湾时间的标准写法 2026-11-02 10:30（名单页表格、导出用） */
export function formatTaiwanTime(iso: string): string {
  const d = new Date(Date.parse(iso) + TW_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** UTC ISO → 日期时间选择器（input type=datetime-local）的值 2026-11-02T10:30（按台湾时间） */
export function taiwanPickerValue(iso: string): string {
  return formatTaiwanTime(iso).replace(' ', 'T');
}

/**
 * Excel 的日期数字（1900 日期系统：1 = 1900-01-01，小数是一天里的时间）→ 台湾时间的写法 2026-11-02 10:30。
 * Excel 里的日期没有时区，按"填的就是台湾时间"处理。认不出返回 null。
 */
export function excelSerialToTaiwanText(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  // 1899-12-30 是 0（Excel 把 1900 年当成闰年，所以从 12-30 起算对 1900-03-01 以后的日期都对）
  const ms = Math.round((serial * 86400_000) / 60_000) * 60_000 + Date.UTC(1899, 11, 30);
  return formatTaiwanTime(new Date(ms - TW_OFFSET_MS).toISOString());
}

/** 一场焦点战首页显示的对战名：有主客队用"主队 vs 客队"，旧数据只有 title 时用 title */
export function matchTitle(m: { home?: string | null; away?: string | null; title?: string | null }): string {
  return m.home && m.away ? `${m.home} vs ${m.away}` : (m.title ?? '');
}

/**
 * 检查并规范一场焦点战：**每个字段都检查完**再返回（一次提示全部错误，C56），错误按字段给出。
 * 文字字段去掉前后空白；长度按字符数（中文一个字算 1）。
 */
export function validateMatch(input: Partial<Record<MatchField, unknown>>, now: number): { ok: true; value: MatchClean } | { ok: false; errors: Partial<Record<MatchField, MatchFieldError>> } {
  const errors: Partial<Record<MatchField, MatchFieldError>> = {};
  const text = (k: 'league' | 'home' | 'away' | 'note', required: boolean): string => {
    const raw = input[k];
    const v = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    if (!v && required) errors[k] = 'REQUIRED';
    else if ([...v].length > MATCH_LIMITS[k]) errors[k] = 'TOO_LONG';
    return v;
  };
  const league = text('league', true);
  const home = text('home', true);
  const away = text('away', true);
  const note = text('note', false);
  let startsAt = '';
  const t = parseTaiwanTime(typeof input.startsAt === 'string' ? input.startsAt : '', now);
  if (t.ok) startsAt = t.iso;
  else errors.startsAt = t.code;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { league, home, away, title: `${home} vs ${away}`, startsAt, note } };
}

/**
 * 批量导入时挑出最后保留的场次（最多 max 场）：先去掉首页已经不显示的（开赛超过 3 小时），再按开赛时间从早到晚留最近的 max 场。
 * existing 是现有的场次（replace = true 时不算）；返回保留和放弃的，各自保持原来的对象。前后端都用这一个函数，预览和实际导入结果一样。
 */
export function pickMatches<E extends { startsAt: string }, N extends { startsAt: string }>(
  existing: E[],
  incoming: N[],
  now: number,
  max = MATCH_LIMITS.max,
): { keep: (E | N)[]; drop: (E | N)[] } {
  const all: (E | N)[] = [...existing, ...incoming];
  const live = all.filter((x) => matchVisible(x.startsAt, now)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const keep = live.slice(0, max);
  return { keep, drop: all.filter((x) => !keep.includes(x)) };
}

/** 导入文件的表头（第一行）：每一列认几种写法，繁简都行 */
export const IMPORT_HEADERS: Record<MatchField, string[]> = {
  league: ['聯賽', '联赛'],
  home: ['主隊', '主队'],
  away: ['客隊', '客队'],
  startsAt: ['開賽時間（台灣）', '开赛时间（台湾）', '開賽時間', '开赛时间', '開賽時間(台灣)', '开赛时间(台湾)'],
  note: ['備註', '备注'],
};
/** 下载的模板用的表头（第一项） */
export const TEMPLATE_HEADERS = (['league', 'home', 'away', 'startsAt', 'note'] as MatchField[]).map((k) => IMPORT_HEADERS[k][0]);

// ---------- 来源（名单页、导出显示用） ----------
/** 常见的 ?src= 值 → 人看得懂的名字；其他的显示"其他：原文" */
const SOURCE_NAMES: Record<string, string> = {
  x: 'X',
  twitter: 'X',
  threads: 'Threads',
  ig: 'Instagram',
  instagram: 'Instagram',
  fb: 'Facebook',
  facebook: 'Facebook',
  line: 'LINE',
  tg: 'Telegram',
  telegram: 'Telegram',
  yt: 'YouTube',
  youtube: 'YouTube',
  ptt: 'PTT',
  dcard: 'Dcard',
  google: 'Google',
};

/** channel（订阅时的来源归类：invite / src 原文 / 空串）→ 显示的名字。zh 决定"订阅者邀请""直接打开"用繁体还是简体 */
export function channelLabel(channel: string | null | undefined, zh: 'zh-TW' | 'zh-CN' = 'zh-TW'): string {
  const c = (channel ?? '').trim();
  if (c === 'invite') return zh === 'zh-TW' ? '訂閱者邀請' : '订阅者邀请';
  if (!c) return zh === 'zh-TW' ? '直接打開' : '直接打开';
  return SOURCE_NAMES[c.toLowerCase()] ?? `其他：${c}`;
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
