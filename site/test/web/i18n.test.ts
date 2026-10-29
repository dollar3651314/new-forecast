/** 三种语言的文案：键齐全、变量一致、繁中用台湾用语（参照 forecast S18 的用语处理）、语言判断。 */
import { describe, expect, it } from 'vitest';
import { LEGAL } from '../../web/src/content/legal';
import { detectLang, MESSAGES, translate } from '../../web/src/i18n';
import ADMIN from '../../web/src/admin/texts.json';

function flat(o: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') Object.assign(out, flat(v, key));
    else out[key] = String(v);
  }
  return out;
}

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('文案键', () => {
  const tw = flat(MESSAGES['zh-TW']);
  it.each(['zh-CN', 'en'] as const)('%s 和繁中的键一样，每个键的变量一样', (lang) => {
    const other = flat(MESSAGES[lang]);
    expect(Object.keys(other).sort()).toEqual(Object.keys(tw).sort());
    for (const k of Object.keys(tw)) expect(vars(other[k]), k).toEqual(vars(tw[k]));
  });
  it('没有空文案；英文里没有中文', () => {
    for (const lang of ['zh-TW', 'zh-CN', 'en'] as const) for (const [k, v] of Object.entries(flat(MESSAGES[lang]))) expect(v.trim(), `${lang} ${k}`).not.toBe('');
    for (const [k, v] of Object.entries(flat(MESSAGES.en))) expect(v, k).not.toMatch(/[一-鿿]/);
  });
  it('法律页三种语言的章节数、每节段落数一样', () => {
    for (const page of Object.values(LEGAL)) {
      const shape = (l: 'zh-TW' | 'zh-CN' | 'en') => [page[l].intro.length, ...page[l].sections.map((s) => s.p.length)];
      expect(shape('zh-CN')).toEqual(shape('zh-TW'));
      expect(shape('en')).toEqual(shape('zh-TW'));
      expect(JSON.stringify(page.en)).not.toMatch(/[一-鿿]/);
    }
  });
});

describe('繁中用台湾用语', () => {
  // 大陆用语 → 台湾用语（forecast S18 词表里和本站有关的部分）
  const MAINLAND = ['郵箱', '數據', '默認', '網絡', '軟件', '信息', '視頻', '服務器', '鏈接', '登錄', '屏幕', '質量', '激活', '賬', '身份認證', '設置'];
  const twTexts = [JSON.stringify(MESSAGES['zh-TW']), JSON.stringify(Object.values(LEGAL).map((p) => p['zh-TW']))].join('\n');
  it.each(MAINLAND)('不出现"%s"', (w) => expect(twTexts).not.toContain(w));
  it('用"電子信箱""連結""網路""伺服器"', () => {
    for (const w of ['電子信箱', '連結', '網路', '伺服器']) expect(twTexts).toContain(w);
  });
});

describe('底线文案', () => {
  const all = JSON.stringify(MESSAGES) + JSON.stringify(LEGAL);
  it('不承诺收益（稳赚、翻倍、保本、必中、别错过）', () => {
    expect(all).not.toMatch(/穩賺|稳赚|翻倍|保本|必中|別錯過|别错过|guaranteed|double your/i);
  });
  it('M-4 不点名任何交易所', () => {
    const dep = JSON.stringify([MESSAGES['zh-TW'].dep, MESSAGES['zh-CN'].dep, MESSAGES.en.dep]);
    expect(dep).toContain('BEP20');
    expect(dep).not.toMatch(/MAX|BitoPro|Binance|幣安|币安|OKX/);
  });
});

describe('语言判断', () => {
  it('网址 ?lang= > 记住的 > 浏览器 > 繁中', () => {
    expect(detectLang('?lang=en', 'zh-CN', ['zh-TW'])).toBe('en');
    expect(detectLang('?lang=xx', 'zh-CN', ['en'])).toBe('zh-CN');
    expect(detectLang('', null, ['zh-CN', 'en'])).toBe('zh-CN');
    expect(detectLang('', null, ['en-GB'])).toBe('en');
    expect(detectLang('', null, ['zh-HK'])).toBe('zh-TW');
    expect(detectLang('', null, ['ja-JP', 'fr'])).toBe('zh-TW');
    expect(detectLang('', null, [])).toBe('zh-TW');
  });
  it('变量替换；缺的键返回键本身（测试能发现）', () => {
    expect(translate(MESSAGES['zh-TW'], 'invite.count', { n: 3 })).toBe('你已邀請 3 人');
    expect(translate(MESSAGES['zh-TW'], 'nope.key')).toBe('nope.key');
  });
});

describe('名单页文案', () => {
  it('焦点战的每个错误码都有文字', () => {
    for (const c of ['REQUIRED', 'TOO_LONG', 'TIME_FORMAT', 'TIME_INVALID']) expect(ADMIN).toHaveProperty(`e${c}`);
  });
});
