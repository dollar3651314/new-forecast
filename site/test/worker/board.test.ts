/** BTC 看板：口径、OKX → 币安换源、超时（C81）、都失败保留旧数据、页面只读缓存。时间固定（C106）。 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BINANCE, compute, GATE, HOUR_MS, KRAKEN, KUCOIN, OKX, pct, refresh, resetMemo, round2, type Candle } from '../../worker/src/board';
import { call, newDb, req, stubFetch, T0, testEnv } from './helpers';

let db: D1Database;
let dispose: () => Promise<void>;
beforeAll(async () => ({ db, dispose } = await newDb()));
afterAll(() => dispose());
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  resetMemo();
  await db.batch([db.prepare('DELETE FROM board_cache'), db.prepare('DELETE FROM source_status')]);
});

// T0 是整点：最近 25 根 1 小时 K 线，最后一根（T0 开盘）还没收盘
const opens = Array.from({ length: 25 }, (_, i) => T0 - (24 - i) * HOUR_MS);
/** 前 15 根涨、后 9 根跌、最后一根（未收盘）涨 */
const closeOf = (i: number) => (i < 15 || i === 24 ? '101.5' : '99.25');
const okxBody = { code: '0', data: opens.map((o, i) => [String(o), '100', '102', '98', closeOf(i), '1', '1', '1', i === 24 ? '0' : '1']).reverse() };
const binanceBody = opens.map((o, i) => [o, '100', '102', '98', closeOf(i), '1', o + HOUR_MS - 1]);
const sec = (o: number) => String(o / 1000);
const kucoinBody = { code: '200000', data: opens.map((o, i) => [sec(o), '100', closeOf(i), '102', '98', '1', '1']).reverse() };
const gateBody = opens.map((o, i) => [sec(o), '1', closeOf(i), '102', '98', '100', '1', i === 24 ? 'false' : 'true']);
/** Kraken 一次给很多根：前面多放 30 根旧的（全跌），只应该用最后 25 根 */
const krakenBody = {
  error: [],
  result: {
    XBTUSDT: [
      ...Array.from({ length: 30 }, (_, j) => [(T0 - (55 - j) * HOUR_MS) / 1000, '100', '102', '98', '90', '99', '1', 1]),
      ...opens.map((o, i) => [o / 1000, '100', '102', '98', closeOf(i), '99', '1', 1]),
    ],
    last: T0 / 1000,
  },
};

describe('口径', () => {
  it('只算已经收盘的最后 24 根；收盘 ≥ 开盘算涨；比例 1 位小数；现价是最新一根的收盘价', () => {
    const candles: Candle[] = OKX.parse(okxBody);
    const s = compute(candles, T0, 'OKX');
    expect(s).toMatchObject({ hours: 24, up: 15, down: 9, upPct: '62.5', downPct: '37.5', price: '101.50', from: new Date(opens[0]).toISOString(), to: new Date(T0).toISOString() });
    // 收盘时间正好等于现在的那一根算还没收盘（closeTime < now 才算，C106）
    expect(compute(candles, T0 - 1, 'OKX').hours).toBe(23);
    expect(compute(BINANCE.parse(binanceBody), T0, 'Binance')).toMatchObject({ up: 15, down: 9, price: '101.50' });
  });

  it('KuCoin、Gate、Kraken 的格式解析成同样的口径（时间是秒、字段顺序不同）', () => {
    for (const [src, body] of [[KUCOIN, kucoinBody], [GATE, gateBody], [KRAKEN, krakenBody]] as const) {
      expect(compute(src.parse(body), T0, src.name), src.name).toMatchObject({ hours: 24, up: 15, down: 9, price: '101.50' });
    }
    expect(() => KUCOIN.parse({ code: '400100', data: [] })).toThrow();
    expect(() => KRAKEN.parse({ error: ['EGeneral:Too many requests'], result: {} })).toThrow();
  });

  it('四舍五入不经过浮点数', () => {
    expect(round2('81544.305')).toBe('81544.31');
    expect(round2('0.004')).toBe('0.00');
    expect(pct(2, 3)).toBe('66.7');
    expect(pct(1, 3)).toBe('33.3');
  });
});

describe('定时任务换源', () => {
  it('OKX 成功：写缓存，页面读到来源和更新时间', async () => {
    const s = stubFetch({ 'https://www.okx.com/': () => Response.json(okxBody) });
    vi.stubGlobal('fetch', s.fn);
    const env = testEnv(db);
    expect(await refresh(env, T0)).toBe('OKX');
    expect(s.calls).toHaveLength(1);
    const b = (await (await call(env, req('GET', '/api/public/board'), T0 + 1000)).json()) as { btc: Record<string, unknown> };
    expect(b.btc).toMatchObject({ available: true, price: '101.50', upPct: '62.5', source: 'OKX', updatedAt: new Date(T0).toISOString() });
  });

  it('OKX 返回错误：换币安；健康检查里记下每个源的结果', async () => {
    const s = stubFetch({ 'https://www.okx.com/': () => new Response('nope', { status: 451 }), 'https://data-api.binance.vision/': () => Response.json(binanceBody) });
    vi.stubGlobal('fetch', s.fn);
    const env = testEnv(db);
    expect(await refresh(env, T0)).toBe('Binance');
    const h = (await (await call(env, req('GET', '/api/health'), T0)).json()) as { checks: { board: { status: string; source: string; sources: { source: string; ok: boolean; error: string | null }[] } } };
    expect(h.checks.board.status).toBe('ok');
    expect(h.checks.board.source).toBe('Binance');
    expect(h.checks.board.sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'OKX', ok: false, error: 'HTTP 451' }), expect.objectContaining({ source: 'Binance', ok: true })]),
    );
  });

  it('OKX 超时（替身一直不回）：按超时放弃、换币安，不会卡住', async () => {
    const hang = (r: Request) => new Promise<Response>((_, rej) => r.signal.addEventListener('abort', () => rej(new DOMException('timeout', 'TimeoutError'))));
    const s = stubFetch({ 'https://www.okx.com/': hang, 'https://data-api.binance.vision/': () => Response.json(binanceBody) });
    vi.stubGlobal('fetch', s.fn);
    const env = testEnv(db);
    const t = Date.now();
    expect(await refresh(env, T0, 50)).toBe('Binance');
    expect(Date.now() - t).toBeLessThan(2000);
    const st = await db.prepare("SELECT error FROM source_status WHERE source = 'OKX'").first<{ error: string }>();
    expect(st!.error).toBe('timeout 50ms');
  });

  it('OKX 429、币安 403（Cloudflare 出口实测）：依次换 KuCoin；KuCoin 也失败再换 Gate、Kraken', async () => {
    const env = testEnv(db);
    vi.stubGlobal(
      'fetch',
      stubFetch({
        'https://www.okx.com/': () => new Response('', { status: 429 }),
        'https://data-api.binance.vision/': () => new Response('', { status: 403 }),
        'https://api.kucoin.com/': () => Response.json(kucoinBody),
      }).fn,
    );
    expect(await refresh(env, T0)).toBe('KuCoin');
    vi.stubGlobal(
      'fetch',
      stubFetch({
        'https://www.okx.com/': () => new Response('', { status: 429 }),
        'https://data-api.binance.vision/': () => new Response('', { status: 403 }),
        'https://api.kraken.com/': () => Response.json(krakenBody),
      }).fn,
    );
    expect(await refresh(env, T0 + 5 * 60_000)).toBe('Kraken');
  });

  it('全部失败：保留上一次的数据和它的更新时间；从来没取到过时页面写"暂时取不到"', async () => {
    const env = testEnv(db);
    vi.stubGlobal('fetch', stubFetch().fn);
    expect(await refresh(env, T0)).toBeNull();
    let b = (await (await call(env, req('GET', '/api/public/board'), T0)).json()) as { btc: Record<string, unknown> };
    expect(b.btc).toMatchObject({ available: false, price: null });
    vi.stubGlobal('fetch', stubFetch({ 'https://www.okx.com/': () => Response.json(okxBody) }).fn);
    await refresh(env, T0);
    vi.stubGlobal('fetch', stubFetch({ 'https://www.okx.com/': () => Response.json({ code: '50011', data: [] }) }).fn);
    expect(await refresh(env, T0 + 5 * 60_000)).toBeNull();
    resetMemo();
    b = (await (await call(env, req('GET', '/api/public/board'), T0 + 5 * 60_000)).json()) as { btc: Record<string, unknown> };
    expect(b.btc).toMatchObject({ available: true, updatedAt: new Date(T0).toISOString() });
    const h = (await (await call(env, req('GET', '/api/health'), T0 + 31 * 60_000)).json()) as { checks: { board: { status: string } } };
    expect(h.checks.board.status).toBe('stale');
  });
});
