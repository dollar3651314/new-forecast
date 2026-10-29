/** 前后端共用的规则（C108）：同一组测试向量，页面和 Worker 都 import shared/rules.ts。 */
import { describe, expect, it } from 'vitest';
import { cleanAttr, formatTaiwanTime, inviteCodeOf, matchVisible, normLang, parseTaiwanTime, poolExample, validateEmail, validateMatch } from '../../shared/rules';

const NOW = Date.UTC(2026, 9, 29, 4, 0, 0); // 台湾时间 2026-10-29 12:00

describe('邮箱', () => {
  it.each([
    ['you@example.com', null],
    ['  You@Example.COM ', null],
    ['', 'REQUIRED'],
    ['   ', 'REQUIRED'],
    [undefined, 'REQUIRED'],
    ['a@b', 'EMAIL_INVALID'],
    ['a@b.c', 'EMAIL_INVALID'],
    ['a b@c.com', 'EMAIL_INVALID'],
    ['a@@c.com', 'EMAIL_INVALID'],
    [`${'a'.repeat(250)}@b.co`, 'EMAIL_INVALID'],
  ])('%j → %s', (v, want) => expect(validateEmail(v)).toBe(want));
});

describe('语言', () => {
  it.each([
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-Hant', 'zh-TW'],
    ['zh', 'zh-TW'],
    ['zh-CN', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
    ['en-US', 'en'],
    ['ja', 'zh-TW'],
    [null, 'zh-TW'],
  ])('%s → %s', (v, want) => expect(normLang(v)).toBe(want));
});

describe('来源参数和邀请码', () => {
  it('来源参数只接受 [A-Za-z0-9._~-]，1～64 个字符', () => {
    expect(cleanAttr(' threads ')).toBe('threads');
    expect(cleanAttr('a b')).toBeNull();
    expect(cleanAttr('x'.repeat(65))).toBeNull();
    expect(cleanAttr(5)).toBeNull();
  });
  it('邀请码 6 位、去掉易混的 0 O 1 I L，大小写不论', () => {
    expect(inviteCodeOf('k7q2xa')).toBe('K7Q2XA');
    expect(inviteCodeOf('K7Q2X0')).toBeNull();
    expect(inviteCodeOf('K7Q2X')).toBeNull();
    expect(inviteCodeOf('threads')).toBeNull();
  });
});

describe('焦点战的时间（台湾时间，写法宽松，C108）', () => {
  it.each([
    ['2026-11-02 10:30', '2026-11-02T02:30:00.000Z'],
    ['2026/11/2 9:30', '2026-11-02T01:30:00.000Z'],
    ['2026.11.02 9', '2026-11-02T01:00:00.000Z'],
    ['2026-11-02T10:30', '2026-11-02T02:30:00.000Z'],
    ['11/02 10:30', '2026-11-02T02:30:00.000Z'],
    ['11/2 1:00', '2026-11-01T17:00:00.000Z'],
    ['11/2 01:00', '2026-11-01T17:00:00.000Z'],
    ['11／2 10：30', '2026-11-02T02:30:00.000Z'],
    // 省略年份、比现在早 60 天以上的算明年（12 月填 1 月的比赛）
    ['1/5 08:00', '2027-01-05T00:00:00.000Z'],
    // 早不到 60 天的仍是今年（刚开赛的比赛）
    ['10/28 20:00', '2026-10-28T12:00:00.000Z'],
  ])('%s → %s', (raw, iso) => expect(parseTaiwanTime(raw, NOW)).toEqual({ ok: true, iso }));

  it.each([
    ['', 'REQUIRED'],
    ['明天', 'TIME_FORMAT'],
    ['10:30', 'TIME_FORMAT'],
    ['2026-02-30 10:00', 'TIME_INVALID'],
    ['2026-11-02 24:00', 'TIME_INVALID'],
    ['2026-11-02 10:60', 'TIME_INVALID'],
    ['2026-13-02 10:00', 'TIME_INVALID'],
  ])('%s → %s', (raw, code) => expect(parseTaiwanTime(raw, NOW)).toEqual({ ok: false, code }));

  it('显示回台湾时间的标准写法', () => {
    expect(formatTaiwanTime('2026-11-01T17:00:00.000Z')).toBe('2026-11-02 01:00');
  });

  it('一次返回全部字段的错误（C56），文字去空白、按字符数算长度', () => {
    expect(validateMatch({ league: ' ', title: '中'.repeat(41), startsAt: 'x', note: 'n'.repeat(61) }, NOW)).toEqual({
      ok: false,
      errors: { league: 'REQUIRED', title: 'TOO_LONG', startsAt: 'TIME_FORMAT', note: 'TOO_LONG' },
    });
    expect(validateMatch({ league: ' NBA ', title: '中'.repeat(40), startsAt: '11/2 9:30' }, NOW)).toEqual({
      ok: true,
      value: { league: 'NBA', title: '中'.repeat(40), startsAt: '2026-11-02T01:30:00.000Z', note: '' },
    });
  });

  it('首页显示开赛不到 3 小时的：正好 3 小时那一毫秒起不显示（C106）', () => {
    const start = new Date(NOW - 3 * 3600_000).toISOString();
    expect(matchVisible(start, NOW - 1)).toBe(true);
    expect(matchVisible(start, NOW)).toBe(false);
  });
});

describe('怎么玩的算例（M-3）和返奖率口径（M-1）', () => {
  it('600 对 400、押中方押 100：抽 20、分 380、拿回 163.33、整体 98%', () => {
    expect(poolExample(600, 400, 100)).toEqual({ fee: 20, share: 380, payout: 163.33, returnRate: 0.98 });
  });
  it('五五开 97.5%、热门赢（80/20）99%、冷门赢（20/80）96%', () => {
    expect(poolExample(50, 50, 1).returnRate).toBeCloseTo(0.975, 10);
    expect(poolExample(80, 20, 1).returnRate).toBeCloseTo(0.99, 10);
    expect(poolExample(20, 80, 1).returnRate).toBeCloseTo(0.96, 10);
  });
});
