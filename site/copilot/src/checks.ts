/**
 * 发出草稿前的程序检查（技术方案第二节"写稿 + 审核"）：AI 自查之外再查一遍，任何一项不过，这条草稿就不给 Amos 看。
 * 规则来源：forecast 简报第二节"不能说的话"、团队手册 A8 第 4 条。
 */
export const BANNED = [
  '稳赚', '穩賺', '必中', '保本', '翻倍', '胜者瓜分', '勝者瓜分', '最后入场', '最後入場', '别错过', '別錯過',
  '智能合约秒出', '智能合約秒出', '输赢全在链上', '輸贏全在鏈上', '链上公开可查', '鏈上公開可查',
  '私房钱', '私房錢',
  // R-1（Amos 2026-10-30 按市场经理建议）：离下注太近的说法
  '彩池', '下注', '赔率', '賠率', '投注',
];
/** R-2（Amos 2026-10-30 按市场经理建议）：原帖里没有的夸大结论不能写（AI 曾自己加"資金流入破紀錄"） */
const SUPERLATIVE = /破[纪紀][录錄]|史上最\S{0,2}|[创創](?:[历歷]史)?新[高低]|[历歷]史新[高低]|有史以[来來]|前所未有/g;
const PRODUCT = /quick\s*come|quickcome|等候名[单單]|返[奖獎]率/i;
const LINK = /https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|online|io|tw|co)\b/i;
/** 排除的题目：命中就不回（AI 漏判时兜底） */
const POLITICS = /[选選]舉|[总總][统統]|立委|政黨|政党|民進黨|民进党|國民黨|国民党|民眾黨|民众党|罷免|罢免|公投|戰爭|战争/;

export type Platform = 'x' | 'threads';

/** X 的字数：中日韩等宽字符算 2，链接算 23（X 的计数规则）；Threads 按字算 */
export function xLength(s: string): number {
  let n = 0;
  for (const ch of s.replace(/https?:\/\/\S+/g, 'x'.repeat(23))) {
    const c = ch.codePointAt(0)!;
    n += c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037) ? 1 : 2;
  }
  return n;
}

export function isExcludedTopic(text: string): boolean {
  return POLITICS.test(text);
}

/** 返回不通过的原因（空数组 = 通过）；postText：原帖文字，用来查"原帖没有的结论" */
export function checkDraft(text: string, platform: Platform, postText = ''): string[] {
  const why: string[] = [];
  const t = text.trim();
  if (!t) why.push('空白');
  for (const w of BANNED) if (t.includes(w)) why.push(`不能说的话：${w}`);
  if (PRODUCT.test(t)) why.push('提到了产品');
  if (LINK.test(t)) why.push('有链接');
  if (POLITICS.test(t)) why.push('政治题目');
  for (const m of new Set(t.match(SUPERLATIVE) ?? [])) if (!postText.includes(m)) why.push(`原帖没有的结论：${m}`);
  if (platform === 'x' ? xLength(t) > 280 : [...t].length > 500) why.push('太长');
  return why;
}
