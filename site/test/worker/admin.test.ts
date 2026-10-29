/** 名单页：一个密码登录、锁定、Cookie、默认关着（404）、指标、名单、焦点战、导出再验证。时间固定（C106）。 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOCK, SESSION_MS } from '../../worker/src/auth';
import { call, cookieFrom, freshIp, newDb, PW, req, stubFetch, subscribeAndConfirm, T0, testEnv } from './helpers';

let db: D1Database;
let dispose: () => Promise<void>;
beforeAll(async () => ({ db, dispose } = await newDb()));
afterAll(() => dispose());
afterEach(() => vi.unstubAllGlobals());

const MIN = 60 * 1000;
let n = 0;
const uniq = (p = 'a') => `${p}${++n}@example.com`;

async function resetAuth() {
  await db.batch([db.prepare('DELETE FROM auth_fail'), db.prepare('DELETE FROM auth_lock')]);
}

async function login(env = testEnv(db), now = T0, ip = freshIp()): Promise<string> {
  const r = await call(env, req('POST', '/api/admin/login', { body: { password: PW }, ip }), now);
  expect(r.status).toBe(204);
  return cookieFrom(r, 'qc_admin');
}

describe('默认关着：ADMIN_PASSWORD 没填或少于 16 个字符', () => {
  for (const [name, pw] of [
    ['没填', undefined],
    ['空', ''],
    ['15 个字符', 'x'.repeat(15)],
  ] as const) {
    it(`${name}：/admin 页面和 /api/admin/* 一律 404，健康检查 admin = not_configured`, async () => {
      const env = testEnv(db, { ADMIN_PASSWORD: pw });
      for (const [m, p] of [
        ['GET', '/admin'],
        ['GET', '/admin/'],
        ['GET', '/admin.html'],
        ['POST', '/api/admin/login'],
        ['GET', '/api/admin/session'],
        ['GET', '/api/admin/metrics'],
        ['POST', '/api/admin/export'],
      ]) {
        const r = await call(env, req(m, p, m === 'POST' ? { body: { password: pw ?? '' } } : {}));
        expect(r.status, `${m} ${p}`).toBe(404);
      }
      const h = await (await call(env, req('GET', '/api/health'))).json();
      expect(h).toMatchObject({ checks: { admin: 'not_configured' } });
      expect(JSON.stringify(h)).not.toContain('x'.repeat(15));
    });
  }

  it('16 个字符（含中文按字符算）就开通：/admin 给名单页', async () => {
    const env = testEnv(db, { ADMIN_PASSWORD: '中'.repeat(16) });
    const r = await call(env, req('GET', '/admin'));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('asset:/admin');
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex');
  });
});

describe('登录和会话', () => {
  it('密码对：204，发两个 Cookie（/admin 和 /api/admin），HttpOnly、Secure、SameSite=Strict、12 小时', async () => {
    await resetAuth();
    const r = await call(testEnv(db), req('POST', '/api/admin/login', { body: { password: PW }, ip: freshIp() }));
    expect(r.status).toBe(204);
    const cookies = r.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const [c, path] of cookies.map((c, i) => [c, ['/admin', '/api/admin'][i]])) {
      expect(c).toMatch(/^qc_admin=\d+\.[A-Za-z0-9_-]{43}; /);
      expect(c).toContain(`Path=${path};`);
      expect(c).toContain('HttpOnly');
      expect(c).toContain('Secure');
      expect(c).toContain('SameSite=Strict');
      expect(c).toContain(`Max-Age=${SESSION_MS / 1000}`);
      expect(c).not.toContain(PW);
    }
  });

  it('没有会话 401；有会话 200；到期那一毫秒起失效；改密码后旧会话失效；篡改的、测试版密码门的 Cookie 不能用', async () => {
    await resetAuth();
    const env = testEnv(db);
    expect((await call(env, req('GET', '/api/admin/session'))).status).toBe(401);
    const ck = await login(env);
    expect((await call(env, req('GET', '/api/admin/session', { cookie: ck }), T0 + SESSION_MS - 1)).status).toBe(200);
    expect((await call(env, req('GET', '/api/admin/session', { cookie: ck }), T0 + SESSION_MS)).status).toBe(401);
    const changed = testEnv(db, { ADMIN_PASSWORD: `${PW}-new` });
    expect((await call(changed, req('GET', '/api/admin/session', { cookie: ck }))).status).toBe(401);
    const [, exp, sig] = /^qc_admin=(\d+)\.(.+)$/.exec(ck)!;
    const longer = `qc_admin=${Number(exp) + 3600_000}.${sig}`;
    expect((await call(env, req('GET', '/api/admin/session', { cookie: longer }))).status).toBe(401);
    const g = await call(testEnv(db, { SITE_GATE: 'on' }), req('POST', '/api/gate/login', { body: { password: PW }, ip: freshIp() }));
    const gate = cookieFrom(g, 'qc_gate').replace('qc_gate=', 'qc_admin=');
    expect((await call(env, req('GET', '/api/admin/session', { cookie: gate }))).status).toBe(401);
  });

  it('登出：清掉两个 Cookie', async () => {
    await resetAuth();
    const env = testEnv(db);
    const ck = await login(env);
    const r = await call(env, req('POST', '/api/admin/logout', { cookie: ck, body: {} }));
    expect(r.status).toBe(204);
    expect(r.headers.getSetCookie().every((c) => c.startsWith('qc_admin=;') && c.includes('Max-Age=0'))).toBe(true);
  });
});

describe('防猜密码', () => {
  it('同一 IP 15 分钟内错 5 次：第 5 次后锁 15 分钟（锁着时正确密码也 429），到点解锁；失败日志只有 IP 和时间', async () => {
    await resetAuth();
    const env = testEnv(db);
    const ip = freshIp();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
    for (let i = 0; i < LOCK.ipFails; i++) {
      const r = await call(env, req('POST', '/api/admin/login', { body: { password: `wrong-guess-${i}` }, ip }), T0 + i * 1000);
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ code: 'WRONG_PASSWORD' });
    }
    spy.mockRestore();
    const lockedAt = T0 + (LOCK.ipFails - 1) * 1000;
    const r = await call(env, req('POST', '/api/admin/login', { body: { password: PW }, ip }), lockedAt + 1000);
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: 'LOCKED', cooldownSeconds: 15 * 60 - 1 });
    // 别的 IP 不受影响
    expect((await call(env, req('POST', '/api/admin/login', { body: { password: PW }, ip: freshIp() }), lockedAt + 1000)).status).toBe(204);
    // 锁到 until 之前；until 那一毫秒起解锁（C106）
    expect((await call(env, req('POST', '/api/admin/login', { body: { password: PW }, ip }), lockedAt + LOCK.ipLockMs - 1)).status).toBe(429);
    expect((await call(env, req('POST', '/api/admin/login', { body: { password: PW }, ip }), lockedAt + LOCK.ipLockMs)).status).toBe(204);
    const failed = logs.filter((l) => l.includes('auth.failed'));
    expect(failed).toHaveLength(LOCK.ipFails);
    expect(failed[0]).toContain(ip);
    expect(logs.join('\n')).not.toContain('wrong-guess');
  });

  it('错的次数分散在 15 分钟以外不锁（窗口不含正好 15 分钟以前那一次）', async () => {
    await resetAuth();
    const env = testEnv(db);
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await call(env, req('POST', '/api/admin/login', { body: { password: 'nope' }, ip }), T0 + i * 1000);
    // 第 5 次在第 1 次之后正好 15 分钟：第 1 次已经出窗口，只算 4 次
    await call(env, req('POST', '/api/admin/login', { body: { password: 'nope' }, ip }), T0 + LOCK.ipWindowMs);
    expect((await call(env, req('POST', '/api/admin/login', { body: { password: PW }, ip }), T0 + LOCK.ipWindowMs + 1)).status).toBe(204);
  });

  it('全站 1 小时内错 20 次（不同 IP）：整个名单页锁 1 小时，任何 IP 都 429', async () => {
    await resetAuth();
    const env = testEnv(db);
    for (let i = 0; i < LOCK.globalFails; i++) await call(env, req('POST', '/api/admin/login', { body: { password: 'nope' }, ip: freshIp() }), T0 + i * 1000);
    const at = T0 + (LOCK.globalFails - 1) * 1000;
    const r = await call(env, req('POST', '/api/admin/login', { body: { password: PW }, ip: freshIp() }), at + 1);
    expect(r.status).toBe(429);
    expect((await call(env, req('POST', '/api/admin/login', { body: { password: PW }, ip: freshIp() }), at + LOCK.globalLockMs)).status).toBe(204);
  });
});

describe('名单页内容', () => {
  it('指标：累计确认、今天新增（台湾时间）、内测、按来源和订阅者邀请的转化；名单打码、可筛内测、分页', async () => {
    await resetAuth();
    await db.batch([db.prepare('DELETE FROM subscribers'), db.prepare('DELETE FROM visit_daily')]);
    const s = stubFetch();
    vi.stubGlobal('fetch', s.fn);
    const env = testEnv(db);
    // 昨天（台湾时间）确认 1 个；今天确认 3 个（其中 2 个内测，1 个经邀请）；1 个待确认
    const yesterday = T0 - 13 * 60 * MIN; // 台湾时间前一天 23:00
    const first = await subscribeAndConfirm(env, s.mails, uniq('old'), { src: 'threads' }, yesterday);
    const code = (first.confirmRes.invite as { code: string }).code;
    await subscribeAndConfirm(env, s.mails, uniq('t1'), { src: 'threads', beta: true });
    await subscribeAndConfirm(env, s.mails, uniq('t2'), { src: 'x', beta: true });
    await subscribeAndConfirm(env, s.mails, uniq('t3'), { ref: code });
    await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('p'), src: 'x' }, ip: freshIp() }));
    for (const b of [{ src: 'threads' }, { src: 'threads' }, { src: 'threads' }, { src: 'threads' }, { src: 'x' }, { ref: code }, { ref: code }]) {
      await call(env, req('POST', '/api/public/visit', { body: b, ip: freshIp() }));
    }
    const ck = await login(env);
    const m = (await (await call(env, req('GET', '/api/admin/metrics', { cookie: ck }))).json()) as Record<string, unknown>;
    expect(m).toMatchObject({ confirmed: 4, pending: 1, unsubscribed: 0, beta: 2, todayNew: 3, todayStart: '2026-10-28T16:00:00.000Z' });
    const ch = m.channels as { channel: string; visits: number; confirmed: number; rate: string | null; beta: number }[];
    expect(ch.find((c) => c.channel === 'threads')).toMatchObject({ visits: 4, confirmed: 2, rate: '50.0%', beta: 1 });
    expect(ch.find((c) => c.channel === 'x')).toMatchObject({ visits: 1, confirmed: 1, rate: '100.0%' });
    expect(ch.find((c) => c.channel === 'invite')).toMatchObject({ visits: 2, confirmed: 1, rate: '50.0%' });

    const list = (await (await call(env, req('GET', '/api/admin/subscribers', { cookie: ck }))).json()) as { total: number; items: { email: string; invites: number; beta: boolean }[] };
    expect(list.total).toBe(5);
    expect(list.items.every((x) => /^.\*\*\*@example\.com$/.test(x.email))).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/old\d+@/);
    expect(list.items.find((x) => x.invites === 1)).toBeTruthy();
    const beta = (await (await call(env, req('GET', '/api/admin/subscribers?beta=1', { cookie: ck }))).json()) as { total: number; items: { beta: boolean }[] };
    expect(beta.total).toBe(2);
    expect(beta.items.every((x) => x.beta)).toBe(true);
    const pending = (await (await call(env, req('GET', '/api/admin/subscribers?status=pending', { cookie: ck }))).json()) as { total: number };
    expect(pending.total).toBe(1);
  });

  it('名单超过一页（50）：next 接着取，能看到全部', async () => {
    await resetAuth();
    await db.prepare('DELETE FROM subscribers').run();
    const stmts = [];
    for (let i = 0; i < 55; i++) {
      const h = i.toString(16).padStart(2, '0');
      stmts.push(
        db
          .prepare(
            "INSERT INTO subscribers (email, lang, status, confirm_token, confirm_sent_at, unsub_token, invite_code, invite_key, ip_hash, created_at, updated_at) VALUES (?1, 'en', 'PENDING', ?2, ?3, ?4, ?5, ?6, 'x', ?3, ?3)",
          )
          .bind(`bulk${i}@example.com`, `${h}`.padEnd(32, 'a'), new Date(T0).toISOString(), `${h}`.padEnd(32, 'b'), `Q${String(i).padStart(5, '0')}`, `${h}`.padEnd(32, 'c')),
      );
    }
    await db.batch(stmts);
    const env = testEnv(db);
    const ck = await login(env);
    const p1 = (await (await call(env, req('GET', '/api/admin/subscribers', { cookie: ck }))).json()) as { items: { id: number }[]; next: number | null; total: number };
    expect(p1.items).toHaveLength(50);
    expect(p1.total).toBe(55);
    const p2 = (await (await call(env, req('GET', `/api/admin/subscribers?before=${p1.next}`, { cookie: ck }))).json()) as { items: { id: number }[]; next: number | null };
    expect(p2.items).toHaveLength(5);
    expect(p2.next).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x) => x.id)).size).toBe(55);
  });

  it('导出：要再输一次密码（会话有效也要）；错了 401 并计入锁定；对了给完整邮箱，格式 qc-waitlist-v1，不含待确认', async () => {
    await resetAuth();
    await db.prepare('DELETE FROM subscribers').run();
    const s = stubFetch();
    vi.stubGlobal('fetch', s.fn);
    const env = testEnv(db);
    const a = uniq('exa');
    const { unsubUrl } = await subscribeAndConfirm(env, s.mails, a, { beta: true, src: 'x' });
    await subscribeAndConfirm(env, s.mails, uniq('exb'));
    await call(env, req('POST', '/api/public/unsubscribe', { body: { token: new URL(unsubUrl).searchParams.get('t') } }));
    await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('exp-pending') }, ip: freshIp() }));
    const ip = freshIp();
    const ck = await login(env, T0, ip);
    expect((await call(env, req('POST', '/api/admin/export', { body: {}, ip }))).status).toBe(401); // 没会话
    const wrong = await call(env, req('POST', '/api/admin/export', { cookie: ck, body: { password: 'not-it' }, ip }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ code: 'WRONG_PASSWORD' });
    expect((await db.prepare('SELECT COUNT(*) AS n FROM auth_fail').first<{ n: number }>())!.n).toBe(1);
    const r = await call(env, req('POST', '/api/admin/export', { cookie: ck, body: { password: PW }, ip }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { format: string; environment: string; next: number | null; count: number; items: Record<string, unknown>[] };
    expect(body).toMatchObject({ format: 'qc-waitlist-v1', environment: 'test', next: null, count: 2 });
    expect(body.items[0]).toMatchObject({ email: a, status: 'unsubscribed', beta: true, src: 'x', channel: 'x', invitedCount: 0, lang: 'zh-TW' });
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ['email', 'lang', 'status', 'beta', 'src', 'cmp', 'ref', 'channel', 'inviteCode', 'invitedCount', 'createdAt', 'confirmedAt', 'unsubscribedAt'].sort(),
    );
    expect(body.items.some((x) => String(x.email).startsWith('exp-pending'))).toBe(false);
  });
});

describe('焦点战（M-2）', () => {
  it('增删改：时间写法宽松、自动整理成台湾时间；一次返回全部字段错误；最多 5 场；首页只显示开赛不到 3 小时的', async () => {
    await resetAuth();
    await db.prepare('DELETE FROM featured_matches').run();
    const env = testEnv(db);
    const ck = await login(env);
    const post = (body: unknown) => call(env, req('POST', '/api/admin/matches', { cookie: ck, body }));
    const bad = await post({ league: '', title: 'x'.repeat(41), startsAt: '明天' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { fields: unknown[] }).fields).toEqual([
      { field: 'league', code: 'REQUIRED' },
      { field: 'title', code: 'TOO_LONG' },
      { field: 'startsAt', code: 'TIME_FORMAT' },
    ]);
    const ok = await post({ league: ' NBA ', title: '湖人 vs 勇士', startsAt: '11/2 9:30' });
    expect(ok.status).toBe(201);
    const m1 = (await ok.json()) as { id: number; startsAt: string; startsAtTw: string; league: string };
    expect(m1).toMatchObject({ league: 'NBA', startsAt: '2026-11-02T01:30:00.000Z', startsAtTw: '2026-11-02 09:30' });
    // 已经开赛 3 小时的（首页不显示）
    await post({ league: 'MLB', title: '世界大賽 第 6 戰', startsAt: '2026-10-29 09:00' });
    const pub = (await (await call(env, req('GET', '/api/public/matches'))).json()) as { items: { title: string }[] };
    expect(pub.items.map((x) => x.title)).toEqual(['湖人 vs 勇士']);
    const adminList = (await (await call(env, req('GET', '/api/admin/matches', { cookie: ck }))).json()) as { items: { title: string; visible: boolean }[] };
    expect(adminList.items.map((x) => [x.title, x.visible])).toEqual([
      ['世界大賽 第 6 戰', false],
      ['湖人 vs 勇士', true],
    ]);
    const put = await call(env, req('PUT', `/api/admin/matches/${m1.id}`, { cookie: ck, body: { league: 'NBA', title: '湖人 vs 塞爾提克', startsAt: '2026/11/02 10:30', note: '例行賽' } }));
    expect(await put.json()).toMatchObject({ title: '湖人 vs 塞爾提克', startsAtTw: '2026-11-02 10:30', note: '例行賽' });
    for (let i = 0; i < 3; i++) expect((await post({ league: '英超', title: `第 ${i} 場`, startsAt: '2026-11-03 00:30' })).status).toBe(201);
    const full = await post({ league: '英超', title: '第 6 場', startsAt: '2026-11-03 00:30' });
    expect(full.status).toBe(409);
    expect((await call(env, req('DELETE', `/api/admin/matches/${m1.id}`, { cookie: ck }))).status).toBe(204);
    expect((await call(env, req('DELETE', `/api/admin/matches/${m1.id}`, { cookie: ck }))).status).toBe(404);
    // 没登录不能改
    expect((await call(env, req('POST', '/api/admin/matches', { body: { league: 'a', title: 'b', startsAt: '2026-11-03 00:30' } }))).status).toBe(401);
  });
});
