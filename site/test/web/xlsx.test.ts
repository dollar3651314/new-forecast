/** 名单页的 Excel：导出的表头和内容（用库读回检查）、焦点战模板、导入的整理和逐行报错（含 Excel 自动变成日期数字的时间）。 */
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { TEMPLATE_HEADERS } from '../../shared/rules';
import { EXPORT_HEADERS, exportFileName, exportRows, parseMatchRows, previewImport, type ExportItem } from '../../web/src/admin/xlsx';

const NOW = Date.UTC(2026, 9, 29, 4, 0, 0);
const ITEM: ExportItem = {
  email: 'friend@example.com',
  lang: 'zh-TW',
  status: 'confirmed',
  beta: false,
  channel: 'invite',
  cmp: null,
  inviter: 'owner@example.com',
  invitedCount: 0,
  createdAt: '2026-10-29T04:00:00.000Z',
  confirmedAt: '2026-10-29T04:05:00.000Z',
  unsubscribedAt: null,
};

describe('导出 Excel', () => {
  it('表头是每个字段的中文含义；值是人看得懂的中文（状态、内测、来源、语言、台湾时间）；写成 xlsx 再读回一样', () => {
    expect(EXPORT_HEADERS).toEqual(['電子信箱', '狀態', '願意內測', '來源', '活動', '邀請人', '邀請成功人數', '語言', '留信箱時間（台灣）', '確認時間（台灣）', '退訂時間（台灣）']);
    const rows = exportRows([ITEM, { ...ITEM, email: 'owner@example.com', status: 'unsubscribed', beta: true, channel: 'threads', cmp: 'w44', inviter: null, invitedCount: 1, lang: 'en', unsubscribedAt: '2026-10-30T01:00:00.000Z' }]);
    const ws = XLSX.utils.aoa_to_sheet([EXPORT_HEADERS, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '名單');
    const back = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
    const table = XLSX.utils.sheet_to_json<unknown[]>(back.Sheets['名單'], { header: 1, defval: '' });
    expect(table).toEqual([
      EXPORT_HEADERS,
      ['friend@example.com', '已確認', '否', '訂閱者邀請', '', 'owner@example.com', 0, '繁體中文', '2026-10-29 12:00', '2026-10-29 12:05', ''],
      ['owner@example.com', '已退訂', '是', 'Threads', 'w44', '', 1, '英文', '2026-10-29 12:00', '2026-10-29 12:05', '2026-10-30 09:00'],
    ]);
    // 不出现内部写法
    expect(JSON.stringify(table)).not.toMatch(/\binvite\b|confirmed|unsubscribed|zh-TW|\bM-\d/);
  });

  it('文件名带日期（台湾时间）；测试版加 TEST', () => {
    expect(exportFileName('2026-10-29T17:00:00.000Z', 'production')).toBe('QuickCome-list-2026-10-30.xlsx');
    expect(exportFileName('2026-10-29T04:00:00.000Z', 'staging')).toBe('QuickCome-list-TEST-2026-10-29.xlsx');
  });
});

describe('焦点战导入', () => {
  it('模板的表头就是导入认的表头', () => {
    expect(TEMPLATE_HEADERS).toEqual(['聯賽', '主隊', '客隊', '開賽時間（台灣）', '備註']);
    const p = parseMatchRows([TEMPLATE_HEADERS, ['NBA', '湖人', '勇士', '2026-11-02 10:30', '']], NOW);
    expect(p.ok && p.rows[0].value).toMatchObject({ league: 'NBA', title: '湖人 vs 勇士', startsAt: '2026-11-02T02:30:00.000Z' });
  });

  it('Excel 把时间变成日期数字、表头用简体或半角括号、列的顺序不同、有空行：都能整理；每一行报出全部错误和行号', () => {
    const p = parseMatchRows(
      [
        ['开赛时间(台湾)', '联赛', '主队', '客队'],
        [46328.4375, 'NBA', '湖人', '勇士'],
        ['', '', '', ''],
        ['明天', '', '甲', ''],
      ],
      NOW,
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(p.rows[0].value).toMatchObject({ startsAt: '2026-11-02T02:30:00.000Z' });
    expect(p.rows[0].input.startsAt).toBe('2026-11-02 10:30');
    expect(p.rows[1].errors).toEqual({ league: 'REQUIRED', away: 'REQUIRED', startsAt: 'TIME_FORMAT' });
  });

  it('空文件、只有表头、缺列：分别说明', () => {
    expect(parseMatchRows([], NOW)).toEqual({ ok: false, reason: 'empty' });
    expect(parseMatchRows([TEMPLATE_HEADERS], NOW)).toEqual({ ok: false, reason: 'empty' });
    expect(parseMatchRows([['聯賽', '主隊']], NOW)).toEqual({ ok: false, reason: 'header', missing: ['客隊', '開賽時間（台灣）'] });
  });

  it('预览：超过 5 场时只留开赛时间最近的 5 场，标出不导入的行和会被替换掉的现有场次；勾"先清空"时不算现有的', () => {
    const rows = ['2026-11-01 08:00', '2026-11-02 08:00', '2026-11-03 08:00', '2026-11-04 08:00', '2026-11-09 08:00'].map((t, i) => [`L${i}`, `主${i}`, `客${i}`, t]);
    const p = parseMatchRows([TEMPLATE_HEADERS.slice(0, 4), ...rows], NOW);
    if (!p.ok) throw new Error('parse');
    const existing = [{ id: 7, title: '現有 vs 一場', startsAt: '2026-11-05T02:00:00.000Z' }];
    const pv = previewImport(p.rows, existing, false, NOW);
    expect([...pv.keepLines]).toEqual([2, 3, 4, 5]);
    expect([...pv.dropLines]).toEqual([6]);
    expect(pv.removed).toEqual([]);
    expect(pv.newCount).toBe(4);
    const pv2 = previewImport(p.rows, existing, true, NOW);
    expect(pv2.newCount).toBe(5);
    expect(pv2.dropLines.size).toBe(0);
  });
});
