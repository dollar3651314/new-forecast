/**
 * 来源参数（M-9、M-10）：网址上的 ?src= ?cmp= ?ref= 记在 sessionStorage（这次浏览里留邮箱时带上），
 * 每次打开页面报一次访问（同一组参数这次浏览只报一次），用来算"访问 → 确认"转化。值的规则和后端同一份（shared/rules.ts cleanAttr）。
 */
import { cleanAttr } from '../../../shared/rules';

export interface Attribution {
  src: string | null;
  cmp: string | null;
  ref: string | null;
}

const KEY = 'qc.attr';
const SENT = 'qc.visit';

export function fromSearch(search: string): Attribution {
  const q = new URLSearchParams(search);
  return { src: cleanAttr(q.get('src')), cmp: cleanAttr(q.get('cmp')), ref: cleanAttr(q.get('ref')) };
}

/** 这次浏览的来源：网址上有就用网址上的（并记住），没有就用记住的 */
export function currentAttribution(search: string): Attribution {
  const a = fromSearch(search);
  try {
    if (a.src || a.cmp || a.ref) sessionStorage.setItem(KEY, JSON.stringify(a));
    else {
      const s = sessionStorage.getItem(KEY);
      if (s) return { ...a, ...(JSON.parse(s) as Attribution) };
    }
  } catch {
    /* 存不了就只用网址上的 */
  }
  return a;
}

/** 报一次访问（失败不影响页面） */
export function reportVisit(a: Attribution): void {
  const sig = `${a.src ?? ''}|${a.cmp ?? ''}|${a.ref ?? ''}`;
  try {
    if (sessionStorage.getItem(SENT) === sig) return;
    sessionStorage.setItem(SENT, sig);
  } catch {
    /* 存不了照样报 */
  }
  void fetch('/api/public/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a), keepalive: true }).catch(() => undefined);
}
