/**
 * BTC 每小时场的看板（M-2 的一档）：BTC 现价和过去 24 小时每小时涨跌的比例。
 * 口径：最近 25 根 1 小时 K 线，只算已经收盘的（收盘时间早于现在）最后 24 根；收盘价 ≥ 开盘价算涨；比例 1 位小数四舍五入；现价是最新一根的收盘价（2 位小数）。
 * - **不在页面请求里取**：定时任务（Cron，每 5 分钟）取一次存进 D1 的 board_cache，页面只读这一行（同一 Worker 实例 30 秒内复用），
 *   Free 每次请求 10 ms CPU 足够。
 * - **数据源**：OKX 优先，取不到换币安 data-api.binance.vision（api.binance.com 在部分地区返回 451），再换 KuCoin、Gate、Kraken（Cloudflare 出口实测 OKX 429、币安 403，见 SOURCES）；都取不到时保留上一次的数据和它的更新时间，
 *   从来没取到过时页面写"暂时取不到"。每个源最近一次的结果记在 source_status，健康检查里看得到。
 * - 外部调用（C81）：每个源一次请求，超时 8 秒（AbortSignal.timeout，连接和读取都算在内），不在本次定时任务里重试（5 分钟后下一次就是重试）；
 *   返回超过 256 KB 当失败。不在数据库事务里调用外部接口。
 * 参照：forecast main 0caa740 cf/src/board.ts（口径、换源、缓存），按 v1 改了返回结构（只给页面用到的字段）。
 */
import type { Env } from './env';
import { json } from './http';
import { iso, log } from './util';

export const HOURS = 24;
export const HOUR_MS = 60 * 60 * 1000;
export const STALE_MS = 30 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 8000;

export interface Candle {
  openTime: number;
  open: string;
  close: string;
  /** 收盘时间（毫秒，这一根的最后 1 毫秒） */
  closeTime: number;
}

export interface Snapshot {
  symbol: string;
  price: string;
  hours: number;
  up: number;
  down: number;
  upPct: string;
  downPct: string;
  from: string;
  to: string;
  fetchedAt: string;
  source: string;
}

export interface Source {
  name: string;
  url: string;
  parse(body: unknown): Candle[];
}

const DECIMAL = /^\d+(\.\d+)?$/;

function dec(v: unknown): string {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!DECIMAL.test(s)) throw new Error('bad price');
  return s;
}

/** OKX：GET /api/v5/market/candles，data 新的在前，每根 [开盘时间, 开, 高, 低, 收, …] */
export const OKX: Source = {
  name: 'OKX',
  url: 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=25',
  parse(body) {
    const b = body as { code?: unknown; data?: unknown };
    if (!b || b.code !== '0' || !Array.isArray(b.data) || b.data.length === 0) throw new Error('OKX: not candles');
    return (b.data as unknown[])
      .map((k) => {
        if (!Array.isArray(k) || k.length < 5) throw new Error('bad candle');
        const openTime = Number(k[0]);
        if (!Number.isFinite(openTime)) throw new Error('bad candle time');
        return { openTime, open: dec(k[1]), close: dec(k[4]), closeTime: openTime + HOUR_MS - 1 };
      })
      .sort((a, b2) => a.openTime - b2.openTime);
  },
};

/** 币安：GET /api/v3/klines，旧的在前，每根 [开盘时间, 开, 高, 低, 收, 量, 收盘时间, …] */
export const BINANCE: Source = {
  name: 'Binance',
  url: 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=25',
  parse(body) {
    if (!Array.isArray(body) || body.length === 0) throw new Error('Binance: not candles');
    return (body as unknown[]).map((k) => {
      if (!Array.isArray(k) || k.length < 7) throw new Error('bad candle');
      const openTime = Number(k[0]);
      const closeTime = Number(k[6]);
      if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) throw new Error('bad candle time');
      return { openTime, open: dec(k[1]), close: dec(k[4]), closeTime };
    });
  },
};

/** KuCoin：GET /api/v1/market/candles，data 新的在前，每根 [开盘时间（秒）, 开, 收, 高, 低, 量, 成交额] */
export const KUCOIN: Source = {
  name: 'KuCoin',
  url: 'https://api.kucoin.com/api/v1/market/candles?type=1hour&symbol=BTC-USDT',
  parse(body) {
    const b = body as { code?: unknown; data?: unknown };
    if (!b || b.code !== '200000' || !Array.isArray(b.data) || b.data.length === 0) throw new Error('KuCoin: not candles');
    return (b.data as unknown[])
      .slice(0, 25)
      .map((k) => {
        if (!Array.isArray(k) || k.length < 5) throw new Error('bad candle');
        const openTime = Number(k[0]) * 1000;
        if (!Number.isFinite(openTime)) throw new Error('bad candle time');
        return { openTime, open: dec(k[1]), close: dec(k[2]), closeTime: openTime + HOUR_MS - 1 };
      })
      .sort((a, b2) => a.openTime - b2.openTime);
  },
};

/** Gate：GET /api/v4/spot/candlesticks，旧的在前，每根 [开盘时间（秒）, 成交额, 收, 高, 低, 开, 量, 是否已收盘] */
export const GATE: Source = {
  name: 'Gate',
  url: 'https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1h&limit=25',
  parse(body) {
    if (!Array.isArray(body) || body.length === 0) throw new Error('Gate: not candles');
    return (body as unknown[]).map((k) => {
      if (!Array.isArray(k) || k.length < 6) throw new Error('bad candle');
      const openTime = Number(k[0]) * 1000;
      if (!Number.isFinite(openTime)) throw new Error('bad candle time');
      return { openTime, open: dec(k[5]), close: dec(k[2]), closeTime: openTime + HOUR_MS - 1 };
    });
  },
};

/** Kraken：GET /0/public/OHLC，result.XBTUSDT 旧的在前，每根 [开盘时间（秒）, 开, 高, 低, 收, …]；一次返回约 720 根，只取最后 25 根 */
export const KRAKEN: Source = {
  name: 'Kraken',
  url: 'https://api.kraken.com/0/public/OHLC?pair=XBTUSDT&interval=60',
  parse(body) {
    const b = body as { error?: unknown; result?: { XBTUSDT?: unknown } };
    const rows = b?.result?.XBTUSDT;
    if (!b || (Array.isArray(b.error) && b.error.length > 0) || !Array.isArray(rows) || rows.length === 0) throw new Error('Kraken: not candles');
    return (rows as unknown[]).slice(-25).map((k) => {
      if (!Array.isArray(k) || k.length < 5) throw new Error('bad candle');
      const openTime = Number(k[0]) * 1000;
      if (!Number.isFinite(openTime)) throw new Error('bad candle time');
      return { openTime, open: dec(k[1]), close: dec(k[4]), closeTime: openTime + HOUR_MS - 1 };
    });
  },
};

/**
 * 按顺序试：OKX → 币安 → KuCoin → Gate → Kraken。
 * 2026-10-29 测试版实测：Cloudflare 出口访问 OKX 返回 429、币安 data-api 返回 403（同样的地址在别处正常），所以加了后面三个备用源（C114）。
 */
export const SOURCES: Source[] = [OKX, BINANCE, KUCOIN, GATE, KRAKEN];

/** 十进制字符串保留 2 位小数，四舍五入（不经过浮点数） */
export function round2(s: string): string {
  const [i, f = ''] = s.split('.');
  const digits = (i + (f + '000').slice(0, 2)).replace(/^0+(?=\d)/, '');
  let n = BigInt(digits);
  if ((f[2] ?? '0') >= '5') n += 1n;
  const str = n.toString().padStart(3, '0');
  return `${str.slice(0, -2)}.${str.slice(-2)}`;
}

/** a × 100 ÷ total，1 位小数四舍五入（"62.5"、"100.0"、"0.0"） */
export function pct(a: number, total: number): string {
  const tenths = Math.floor((2 * a * 1000 + total) / (2 * total));
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

function cmpDec(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const len = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(len, '0'));
  const y = BigInt(bi + bf.padEnd(len, '0'));
  return x === y ? 0 : x > y ? 1 : -1;
}

export function compute(candles: Candle[], now: number, source: string, n = HOURS, symbol = 'BTCUSDT'): Snapshot {
  if (candles.length === 0) throw new Error('no candles');
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
  const latest = sorted[sorted.length - 1];
  // 收盘时间正好等于现在的那一根还没收盘（closeTime 是这一根的最后 1 毫秒，C106）
  const closed = sorted.filter((k) => k.closeTime < now);
  const use = closed.slice(Math.max(0, closed.length - n));
  if (use.length === 0) throw new Error('no closed candles');
  const up = use.filter((k) => cmpDec(k.close, k.open) >= 0).length;
  const down = use.length - up;
  return {
    symbol,
    price: round2(latest.close),
    hours: use.length,
    up,
    down,
    upPct: pct(up, use.length),
    downPct: pct(down, use.length),
    from: iso(use[0].openTime),
    to: iso(use[use.length - 1].closeTime + 1),
    fetchedAt: iso(now),
    source,
  };
}

async function fetchSource(s: Source, now: number, timeoutMs: number): Promise<Snapshot> {
  const res = await fetch(s.url, { headers: { Accept: 'application/json', 'User-Agent': 'new-forecast-site/1' }, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 256 * 1024) throw new Error('response too large');
  return compute(s.parse(JSON.parse(text)), now, s.name);
}

/** 定时任务：按顺序试每个源，第一个成功的写进 board_cache；每个试过的源都记一次结果。返回用了哪个源（都失败为 null） */
export async function refresh(env: Env, now: number, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  for (const s of SOURCES) {
    let snap: Snapshot;
    try {
      snap = await fetchSource(s, now, timeoutMs);
    } catch (e) {
      const err = e as Error;
      const msg = (err?.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : String(err?.message || e)).slice(0, 200);
      log('board.source_failed', { source: s.name, error: msg });
      await env.DB.prepare(
        'INSERT INTO source_status (source, ok, error, failures, checked_at) VALUES (?1, 0, ?2, 1, ?3) ' +
          'ON CONFLICT (source) DO UPDATE SET ok = 0, error = ?2, failures = failures + 1, checked_at = ?3',
      )
        .bind(s.name, msg, iso(now))
        .run();
      continue;
    }
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO board_cache (id, snapshot, updated_at) VALUES (1, ?1, ?2) ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at',
      ).bind(JSON.stringify(snap), snap.fetchedAt),
      env.DB.prepare(
        'INSERT INTO source_status (source, ok, error, failures, checked_at, last_ok_at) VALUES (?1, 1, NULL, 0, ?2, ?2) ' +
          'ON CONFLICT (source) DO UPDATE SET ok = 1, error = NULL, failures = 0, checked_at = ?2, last_ok_at = ?2',
      ).bind(s.name, iso(now)),
    ]);
    memo = null;
    return s.name;
  }
  return null;
}

let memo: { at: number; snap: Snapshot | null } | null = null;
const MEMO_MS = 30_000;

export function resetMemo(): void {
  memo = null;
}

export async function cached(env: Env, now: number): Promise<Snapshot | null> {
  if (memo && now >= memo.at && now - memo.at < MEMO_MS) return memo.snap;
  const row = await env.DB.prepare('SELECT snapshot FROM board_cache WHERE id = 1').first<{ snapshot: string }>();
  const snap = row ? (JSON.parse(row.snapshot) as Snapshot) : null;
  memo = { at: now, snap };
  return snap;
}

/** GET /api/public/board：页面只读缓存；写来源和更新时间 */
export async function board(env: Env, now: number): Promise<Response> {
  const s = await cached(env, now);
  const btc = s
    ? { available: true, price: s.price, hours: s.hours, up: s.up, down: s.down, upPct: s.upPct, downPct: s.downPct, source: s.source, updatedAt: s.fetchedAt }
    : { available: false, price: null, hours: 0, up: 0, down: 0, upPct: null, downPct: null, source: null, updatedAt: null };
  return json({ btc }, 200, { 'Cache-Control': 'public, max-age=30' });
}

export interface BoardHealth {
  status: 'ok' | 'stale' | 'down';
  updatedAt: string | null;
  ageSeconds: number | null;
  source: string | null;
  sources: { source: string; ok: boolean; error: string | null; failures: number; checkedAt: string; lastOkAt: string | null }[];
}

export async function boardHealth(env: Env, now: number): Promise<BoardHealth> {
  const row = await env.DB.prepare('SELECT snapshot, updated_at FROM board_cache WHERE id = 1').first<{ snapshot: string; updated_at: string }>();
  const st = await env.DB.prepare('SELECT source, ok, error, failures, checked_at, last_ok_at FROM source_status ORDER BY source').all<{
    source: string;
    ok: number;
    error: string | null;
    failures: number;
    checked_at: string;
    last_ok_at: string | null;
  }>();
  const age = row ? Math.max(0, Math.round((now - Date.parse(row.updated_at)) / 1000)) : null;
  const snap = row ? (JSON.parse(row.snapshot) as Snapshot) : null;
  return {
    status: age === null ? 'down' : age * 1000 > STALE_MS ? 'stale' : 'ok',
    updatedAt: row?.updated_at ?? null,
    ageSeconds: age,
    source: snap?.source ?? null,
    sources: (st.results ?? []).map((r) => ({ source: r.source, ok: r.ok === 1, error: r.error, failures: r.failures, checkedAt: r.checked_at, lastOkAt: r.last_ok_at })),
  };
}
