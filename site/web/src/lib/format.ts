/** 时间和数字的显示：时间一律按台湾时间（Asia/Taipei）显示，和名单页填写的时间一致。 */
import type { Lang } from '../../../shared/rules';

const LOCALE: Record<Lang, string> = { 'zh-TW': 'zh-TW', 'zh-CN': 'zh-CN', en: 'en-US' };

/** 开赛时间：11/02（日）10:30；英文 Sun 11/02 10:30 */
export function kickoff(iso: string, lang: Lang): string {
  const d = new Date(iso);
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE[lang], { timeZone: 'Asia/Taipei', ...o }).format(d);
  const md = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  if (lang === 'en') return `${part({ weekday: 'short' })} ${md} ${hm}`;
  return `${md}（${part({ weekday: 'narrow' })}）${hm}`;
}

/** 更新时间：10/29 14:05 */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  const md = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${md} ${hm}`;
}

/** 千分位，最多 2 位小数（行情价格本来就是 2 位小数的字符串，原样加千分位，不经过浮点数） */
export function money(v: number | string): string {
  if (typeof v === 'string') {
    const [i, f] = v.split('.');
    return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f !== undefined ? `.${f}` : ''}`;
  }
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
