/**
 * 三种语言（繁中默认、简中、英文）：跟随浏览器，可以切换并记住（localStorage 的 qc.lang）。网址上的 ?lang= 优先（分享卡片、sitemap 用）。
 * 文案在同目录的 JSON（C6：不写死在组件里）；三份的键必须一样（site/test/web/i18n.test.ts）。
 * 参照：forecast main 0caa740 web/site/src/i18n/（语言判断、三份文案键一致的检查），按 v1 改写。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LANGS, normLang, type Lang } from '../../../shared/rules';
import en from './en.json';
import zhCN from './zh-CN.json';
import zhTW from './zh-TW.json';

export type Messages = typeof zhTW;
export const MESSAGES: Record<Lang, Messages> = { 'zh-TW': zhTW, 'zh-CN': zhCN, en };
export const LANG_LABEL: Record<Lang, string> = { 'zh-TW': '繁中', 'zh-CN': '简中', en: 'EN' };
export const HTML_LANG: Record<Lang, string> = { 'zh-TW': 'zh-Hant-TW', 'zh-CN': 'zh-Hans', en: 'en' };
export const STORAGE_KEY = 'qc.lang';

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 网址 ?lang= → 记住的 → 浏览器语言 → 繁中 */
export function detectLang(search: string, saved: string | null, browser: readonly string[]): Lang {
  const q = new URLSearchParams(search).get('lang');
  if (q && (LANGS as string[]).includes(q)) return q as Lang;
  if (saved && (LANGS as string[]).includes(saved)) return saved as Lang;
  for (const b of browser) {
    const low = b.toLowerCase();
    if (low.startsWith('zh') || low.startsWith('en')) return normLang(b);
  }
  return normLang(undefined);
}

/** 取键 a.b 的文字，{name} 换成变量；键不存在时返回键本身（测试能发现） */
export function translate(msgs: Messages, key: string, vars: Record<string, string | number> = {}): string {
  let v: unknown = msgs;
  for (const k of key.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  const s = typeof v === 'string' ? v : key;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

interface Ctx {
  lang: Lang;
  setLang(l: Lang): void;
  t(key: string, vars?: Record<string, string | number>): string;
}

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => initial ?? detectLang(location.search, stored(), navigator.languages ?? [navigator.language]));
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* 无痕模式等存不了时只在这次有效 */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[lang];
  }, [lang]);
  const value = useMemo<Ctx>(() => ({ lang, setLang, t: (k, v) => translate(MESSAGES[lang], k, v) }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext);
  if (!c) throw new Error('useI18n 要在 I18nProvider 里用');
  return c;
}
