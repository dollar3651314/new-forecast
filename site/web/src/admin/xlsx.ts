/**
 * 名单页的 Excel：导出名单、焦点战模板、导入焦点战（v1.1，Amos 验收："要 Excel 格式，表头要用每个字段的含义"、"数据不能导入吗"）。
 * - 全部在浏览器里做（Worker 免费版每次请求只有 10ms CPU，Worker 只返回数据 / 接收整理好的 JSON）。
 * - 用 SheetJS 社区版 0.20.3（package.json 固定版本，从 cdn.sheetjs.com 安装；npm 上的旧版 0.18 有已知漏洞）。
 *   库比较大，只在点"导出""下载模板""选择文件"时才加载（动态 import，名单页打开时不加载）。
 * - 下面的整理函数（exportRows、parseMatchRows）不依赖库，测试直接调（site/test/web/xlsx.test.ts）。
 */
import {
  channelLabel,
  excelSerialToTaiwanText,
  formatTaiwanTime,
  IMPORT_HEADERS,
  pickMatches,
  TEMPLATE_HEADERS,
  validateMatch,
  type MatchClean,
  type MatchField,
  type MatchFieldError,
} from '../../../shared/rules';

type XLSXModule = typeof import('xlsx');
let lib: Promise<XLSXModule> | null = null;
export function loadXlsx(): Promise<XLSXModule> {
  lib ??= import('xlsx');
  return lib;
}

// ---------- 导出名单 ----------
export interface ExportItem {
  email: string;
  lang: string;
  status: string;
  beta: boolean;
  channel: string;
  cmp: string | null;
  inviter: string | null;
  invitedCount: number;
  createdAt: string;
  confirmedAt: string | null;
  unsubscribedAt: string | null;
}

export const EXPORT_HEADERS = ['電子信箱', '狀態', '願意內測', '來源', '活動', '邀請人', '邀請成功人數', '語言', '留信箱時間（台灣）', '確認時間（台灣）', '退訂時間（台灣）'];
const STATUS_ZH: Record<string, string> = { confirmed: '已確認', unsubscribed: '已退訂', pending: '待確認' };
const LANG_ZH: Record<string, string> = { 'zh-TW': '繁體中文', 'zh-CN': '簡體中文', en: '英文' };
const tw = (iso: string | null) => (iso ? formatTaiwanTime(iso) : '');

/** 导出的每一行（和 EXPORT_HEADERS 一一对应），值都是人看得懂的中文；数字列保持数字 */
export function exportRows(items: ExportItem[]): (string | number)[][] {
  return items.map((x) => [
    x.email,
    STATUS_ZH[x.status] ?? x.status,
    x.beta ? '是' : '否',
    channelLabel(x.channel, 'zh-TW'),
    x.cmp ?? '',
    x.inviter ?? '',
    x.invitedCount,
    LANG_ZH[x.lang] ?? x.lang,
    tw(x.createdAt),
    tw(x.confirmedAt),
    tw(x.unsubscribedAt),
  ]);
}

/**
 * 文件名带日期（台湾时间）；不是正式版加 TEST。只用英文字母和数字：浏览器对页面生成的下载文件，
 * 文件名有中文时有的会改成"download"（本机 Chromium 实测），所以不用中文。
 */
export function exportFileName(exportedAt: string, environment: string): string {
  return `QuickCome-list${environment === 'production' ? '' : '-TEST'}-${formatTaiwanTime(exportedAt).slice(0, 10)}.xlsx`;
}

function download(data: ArrayBuffer, name: string): void {
  const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export async function downloadExport(items: ExportItem[], exportedAt: string, environment: string): Promise<string> {
  const X = await loadXlsx();
  const ws = X.utils.aoa_to_sheet([EXPORT_HEADERS, ...exportRows(items)]);
  ws['!cols'] = [30, 8, 9, 12, 12, 30, 13, 10, 18, 18, 18].map((wch) => ({ wch }));
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, '名單');
  const name = exportFileName(exportedAt, environment);
  download(X.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, name);
  return name;
}

// ---------- 焦点战模板和导入 ----------
export const TEMPLATE_FILE = 'QuickCome-matches-template.xlsx';
const TEMPLATE_HELP = [
  ['怎麼填'],
  ['1. 在「焦點戰」這一頁，從第 2 行起一行填一場，第 1 行的表頭不要改。'],
  ['2. 聯賽：NBA、MLB、英超、西甲、歐冠、中職，或其他聯賽的名稱（最多 20 個字）。'],
  ['3. 主隊、客隊：各最多 20 個字，首頁顯示成「主隊 vs 客隊」。'],
  ['4. 開賽時間（台灣）：寫台灣時間，例如 2026-11-02 10:30；寫成 2026/11/2 9:30 也可以。'],
  ['5. 備註：選填，只在名單頁顯示，首頁不顯示。'],
  ['6. 最多 10 場：超過時只保留開賽時間最近的 10 場；首頁顯示其中最近的 6 場。'],
  ['例子：NBA ｜ 湖人 ｜ 勇士 ｜ 2026-11-02 10:30 ｜ （空白）'],
];

export async function downloadTemplate(): Promise<void> {
  const X = await loadXlsx();
  const ws = X.utils.aoa_to_sheet([TEMPLATE_HEADERS]);
  ws['!cols'] = [12, 16, 16, 20, 24].map((wch) => ({ wch }));
  const help = X.utils.aoa_to_sheet(TEMPLATE_HELP);
  help['!cols'] = [{ wch: 80 }];
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, '焦點戰');
  X.utils.book_append_sheet(wb, help, '填寫說明');
  download(X.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer, TEMPLATE_FILE);
}

export const FIELD_ORDER: MatchField[] = ['league', 'home', 'away', 'startsAt', 'note'];

export interface ParsedRow {
  /** 文件里的行号（表头是第 1 行） */
  line: number;
  input: Record<MatchField, string>;
  errors: Partial<Record<MatchField, MatchFieldError>>;
  value: MatchClean | null;
}

export type ParseResult = { ok: true; rows: ParsedRow[] } | { ok: false; reason: 'empty' } | { ok: false; reason: 'header'; missing: string[] };

const normHeader = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, '')
    .replace(/\(/g, '（')
    .replace(/\)/g, '）');

function cellText(v: unknown, field: MatchField): string {
  if (v === null || v === undefined) return '';
  // Excel 把"2026-11-02 10:30"自动变成日期时，读出来是日期数字
  if (field === 'startsAt' && typeof v === 'number') return excelSerialToTaiwanText(v) ?? String(v);
  if (v instanceof Date) return formatTaiwanTime(new Date(v.getTime()).toISOString());
  return String(v).trim();
}

/** 表格（第一行表头）→ 每一行的检查结果。空行跳过；每一行都用和后端同一套规则检查（C108），一次给出全部错误（C56） */
export function parseMatchRows(table: unknown[][], now: number): ParseResult {
  const rows = table.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
  if (rows.length === 0) return { ok: false, reason: 'empty' };
  const header = rows[0].map(normHeader);
  const col = {} as Record<MatchField, number>;
  const missing: string[] = [];
  for (const f of FIELD_ORDER) {
    const i = header.findIndex((h) => IMPORT_HEADERS[f].map(normHeader).includes(h));
    if (i < 0 && f !== 'note') missing.push(IMPORT_HEADERS[f][0]);
    col[f] = i;
  }
  if (missing.length) return { ok: false, reason: 'header', missing };
  const lineOf = new Map(rows.map((r) => [r, table.indexOf(r) + 1]));
  const body = rows.slice(1);
  if (body.length === 0) return { ok: false, reason: 'empty' };
  return {
    ok: true,
    rows: body.map((r) => {
      const input = Object.fromEntries(FIELD_ORDER.map((f) => [f, col[f] >= 0 ? cellText(r[col[f]], f) : ''])) as Record<MatchField, string>;
      const v = validateMatch(input, now);
      return { line: lineOf.get(r)!, input, errors: v.ok ? {} : v.errors, value: v.ok ? v.value : null };
    }),
  };
}

/** 文件内容（老一些的浏览器、测试用的 jsdom 没有 Blob.arrayBuffer，用 FileReader） */
function readBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

/** 读文件：.csv 按 UTF-8 文本读；其他按 Excel 读第一张表。读不了抛错 */
export async function readTable(file: File): Promise<unknown[][]> {
  const X = await loadXlsx();
  const buf = await readBuffer(file);
  const wb = /\.csv$/i.test(file.name)
    ? X.read(new TextDecoder('utf-8').decode(buf).replace(/^﻿/, ''), { type: 'string', raw: true })
    : X.read(buf, { type: 'array', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  return X.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' });
}

/** 导入预览：哪些行导入后会显示、哪些因为超过上限不导入、现有的哪些会被替换掉（和后端同一个 pickMatches） */
export function previewImport<E extends { id: number; startsAt: string; title: string }>(rows: ParsedRow[], existing: E[], replace: boolean, now: number) {
  const ok = rows.filter((r) => r.value).map((r) => ({ ...r, startsAt: r.value!.startsAt }));
  const { keep, drop } = pickMatches(replace ? [] : existing, ok, now);
  return {
    keepLines: new Set(keep.filter((x) => 'line' in x).map((x) => (x as { line: number }).line)),
    dropLines: new Set(drop.filter((x) => 'line' in x).map((x) => (x as { line: number }).line)),
    removed: drop.filter((x): x is E => 'id' in x),
    newCount: keep.filter((x) => 'line' in x).length,
  };
}
