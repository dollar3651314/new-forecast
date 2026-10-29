/** 名单页：一个密码登录、锁定（对外一律同一个通用回答）、Cookie、默认关着（404）、指标、邀请排行、名单（邀请人）、焦点战（含批量导入）、导出再验证。时间固定（C106）。 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOCK, SESSION_MS } from '../../worker/src/auth';
import { MATCH_LIMITS } from '../../shared/rules';
import { AP, call, cookieFrom, freshIp, newDb, PW, req, stubFetch, subscribeAndConfirm, T0, testEnv } from './helpers';

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
  const r = await call(env, req('POST', `${AP}/api/login`, { body: { password: PW }, ip }), now);
  expect(r.status).toBe(204);
  return cookieFrom(r, 'qc_admin');
}

/** 普通不存在的地址的回答（页面：静态资源的"找不到"；接口：404 JSON），名单页没开通、旧地址都要和它一模一样 */
async function sameAsUnknown(env: ReturnType<typeof testEnv>, m: string, p: string) {
  const r = await call(env, req(m, p, m === 'POST' ? { body: { password: PW } } : {}));
  const u = await call(env, req(m, p.startsWith('/api/') ? '/api/no-such-thing' : '/no-such-page', m === 'POST' ? { body: { password: PW } } : {}));
  expect(r.status, `${m} ${p}`).toBe(u.status);
  expect(await r.text(), `${m} ${p}`).toBe(await u.text());
}

describe('默认关着：ADMIN_PATH、ADMIN_PASSWORD 任一没配好', () => {
  for (const [name, over] of [
    ['密码没填', { ADMIN_PASSWORD: undefined }],
    ['密码 15 个字符', { ADMIN_PASSWORD: 'x'.repeat(15) }],
    ['地址没填', { ADMIN_PATH: undefined }],
    ['地址太短（/ 后面少于 6 个字符）', { ADMIN_PATH: '/qc-op' }],
    ['地址有别的字符', { ADMIN_PATH: '/qc_ops/test-0001' }],
  ] as const) {
    it(`${name}：名单页地址下的页面和接口都和不存在的地址一样，健康检查 admin = not_configured`, async () => {
      const env = testEnv(db, over);
      const base = over.ADMIN_PATH ?? AP;
      for (const [m, p] of [
        ['GET', base],
        ['GET', `${base}/`],
        ['POST', `${base}/api/login`],
        ['GET', `${base}/api/session`],
        ['GET', `${base}/api/metrics`],
      ] as const) {
        // 没开通时这个地址就是一个普通的不存在的页面（交给静态资源，线上是首页的"找不到"）
        const r = await call(env, req(m, p, m === 'POST' ? { body: { password: PW } } : {}));
        expect(await r.text(), `${m} ${p}`).toBe(`asset:${p}`);
      }
      const h = await (await call(env, req('GET', '/api/health'))).json();
      expect(h).toMatchObject({ checks: { admin: 'not_configured' } });
      expect(JSON.stringify(h)).not.toContain('x'.repeat(15));
    });
  }

  for (const v of ['qc-ops', '/qc-ops/', ' qc-ops/ ']) {
    it(`地址写成 "${v}"（忘了开头的 / 或多写了结尾的 /）也能用，地址按 /qc-ops 算`, async () => {
      const env = testEnv(db, { ADMIN_PATH: v });
      const h = await (await call(env, req('GET', '/api/health'))).json();
      expect(h).toMatchObject({ checks: { admin: 'ok' } });
      const r = await call(env, req('GET', '/qc-ops/api/session'));
      expect(await r.text()).not.toBe('asset:/qc-ops/api/session');
    });
  }

  it('地址 / 后面正好 6 个字符就能用（Amos 2026-10-29：大于等于 6 个字符）', async () => {
    const env = testEnv(db, { ADMIN_PATH: '/qc-ops' });
    const h = await (await call(env, req('GET', '/api/health'))).json();
    expect(h).toMatchObject({ checks: { admin: 'ok' } });
    expect(JSON.stringify(h)).not.toContain('/qc-ops');
    const r = await call(env, req('GET', '/qc-ops/api/session'));
    expect(await r.text()).not.toBe('asset:/qc-ops/api/session');
  });

  it('开通后：名单页在 ADMIN_PATH 下（noindex、不缓存）；/admin、/admin.html、/api/admin/*、名单页的 HTML 文件 /console.html 都和不存在的地址一模一样', async () => {
    const env = testEnv(db, { ADMIN_PASSWORD: '中'.repeat(16) });
    const r = await call(env, req('GET', AP));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('asset:/console');
    expect(r.headers.get('X-Robots-Tag')).toMatch(/^noindex/);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect((await call(testEnv(db, { ENVIRONMENT: 'production' }), req('GET', AP))).headers.get('X-Robots-Tag')).toBe('noindex');
    for (const p of ['/admin', '/admin/', '/admin.html', '/console', '/console.html']) {
      const x = await call(env, req('GET', p));
      // 都交给静态资源按"找不到"处理（线上：首页的"找不到这个页面"）；/console.html 换成一个不存在的地址再交，不会给出名单页
      expect(await x.text(), p).toBe(/^\/console/.test(p) ? 'asset:/__not_found__' : `asset:${p}`);
    }
    for (const [m, p] of [
      ['POST', '/api/admin/login'],
      ['GET', '/api/admin/session'],
      ['GET', '/api/admin/metrics'],
      ['POST', '/api/admin/export'],
    ] as const) {
      await sameAsUnknown(env, m, p);
    }
  });
});

describe('登录和会话', () => {
  it('密码对：204，发一个只在名单页地址下有效的 Cookie，HttpOnly、Secure、SameSite=Strict、12 小时', async () => {
    await resetAuth();
    const r = await call(testEnv(db), req('POST', `${AP}/api/login`, { body: { password: PW }, ip: freshIp() }));
    expect(r.status).toBe(204);
    const cookies = r.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    for (const c of cookies) {
      expect(c).toMatch(/^qc_admin=\d+\.[A-Za-z0-9_-]{43}; /);
      expect(c).toContain(`Path=${AP};`);
      expect(c).toContain('HttpOnly');
      expect(c).toContain('Secure');
      expect(c).toContain('SameSite=Strict');
      expect(c).toContain(`Max-Age=${SESSION_MS / 1000}`);
      expect(c).not.toContain(PW);
    }
  });

  it('没有会话 401；有会话 200；到期那一毫秒起失效；改密码后旧会话失效；篡改的 Cookie 不能用', async () => {
    await resetAuth();
    const env = testEnv(db);
    expect((await call(env, req('GET', `${AP}/api/session`))).status).toBe(401);
    const ck = await login(env);
    expect((await call(env, req('GET', `${AP}/api/session`, { cookie: ck }), T0 + SESSION_MS - 1)).status).toBe(200);
    expect((await call(env, req('GET', `${AP}/api/session`, { cookie: ck }), T0 + SESSION_MS)).status).toBe(401);
    const changed = testEnv(db, { ADMIN_PASSWORD: `${PW}-new` });
    expect((await call(changed, req('GET', `${AP}/api/session`, { cookie: ck }))).status).toBe(401);
    const [, exp, sig] = /^qc_admin=(\d+)\.(.+)$/.exec(ck)!;
    const longer = `qc_admin=${Number(exp) + 3600_000}.${sig}`;
    expect((await call(env, req('GET', `${AP}/api/session`, { cookie: longer }))).status).toBe(401);
  });

  it('登出：清掉 Cookie', async () => {
    await resetAuth();
    const env = testEnv(db);
    const ck = await login(env);
    const r = await call(env, req('POST', `${AP}/api/logout`, { cookie: ck, body: {} }));
    expect(r.status).toBe(204);
    expect(r.headers.getSetCookie().every((c) => c.startsWith('qc_admin=;') && c.includes('Max-Age=0'))).toBe(true);
  });
});

/** 对外的回答：密码错、被锁都一样（v1.1 Amos："不要那么明确，坏人了解规则后会有针对地尝试"） */
async function expectGenericFailure(r: Response) {
  expect(r.status).toBe(401);
  expect(r.headers.get('Retry-After')).toBeNull();
  expect(await r.json()).toEqual({ code: 'AUTH_FAILED', message: 'authentication failed', fields: [] });
}

describe('防猜密码', () => {
  it('同一 IP 15 分钟内错 5 次：第 5 次后锁 15 分钟（锁着时正确密码也不行），到点解锁；对外一律同一个通用回答，规则只写日志', async () => {
    await resetAuth();
    const env = testEnv(db);
    const ip = freshIp();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s));
    for (let i = 0; i < LOCK.ipFails; i++) {
      await expectGenericFailure(await call(env, req('POST', `${AP}/api/login`, { body: { password: `wrong-guess-${i}` }, ip }), T0 + i * 1000));
    }
    const lockedAt = T0 + (LOCK.ipFails - 1) * 1000;
    // 锁着时输对密码：回答和密码错一模一样（不说被锁、不说还要等多久）
    await expectGenericFailure(await call(env, req('POST', `${AP}/api/login`, { body: { password: PW }, ip }), lockedAt + 1000));
    spy.mockRestore();
    // 规则只写日志：锁定和"锁着时被拒绝"都记下
    expect(logs.some((l) => l.includes('auth.locked'))).toBe(true);
    expect(logs.some((l) => l.includes('auth.rejected_locked'))).toBe(true);
    // 别的 IP 不受影响
    expect((await call(env, req('POST', `${AP}/api/login`, { body: { password: PW }, ip: freshIp() }), lockedAt + 1000)).status).toBe(204);
    // 锁到 until 之前；until 那一毫秒起解锁（C106）
    expect((await call(env, req('POST', `${AP}/api/login`, { body: { password: PW }, ip }), lockedAt + LOCK.ipLockMs - 1)).status).toBe(401);
    expect((await call(env, req('POST', `${AP}/api/login`, { body: { password: PW }, ip }), lockedAt + LOCK.ipLockMs)).status).toBe(204);
    const failed = logs.filter((l) => l.includes('auth.failed'));
    expect(failed).toHaveLength(LOCK.ipFails);
    expect(failed[0]).toContain(ip);
    expect(logs.join('\n')).not.toContain('wrong-guess');
  });

  it('错的次数分散在 15 分钟以外不锁（窗口不含正好 15 分钟以前那一次）', async () => {
    await resetAuth();
    const env = testEnv(db);
    const ip = freshIp();
    for (let i = 0; i < 4; i++) await call(env, req('POST', `${AP}/api/login`, { body: { password: 'nope' }, ip }), T0 + i * 1000);
    // 第 5 次在第 1 次之后正好 15 分钟：第 1 次已经出窗口，只算 4 次
    await call(env, req('POST', `${AP}/api/login`, { body: { password: 'nope' }, ip }), T0 + LOCK.ipWindowMs);
    expect((await call(env, req('POST', `${AP}/api/login`, { body: { password: PW }, ip }), T0 + LOCK.ipWindowMs + 1)).status).toBe(204);
  });

  it('全站 1 小时内错 20 次（不同 IP）：整个名单页锁 1 小时，任何 IP 输对也是同一个通用回答', async () => {
    await resetAuth();
    const env = testEnv(db);
    for (let i = 0; i < LOCK.globalFails; i++) await call(env, req('POST', `${AP}/api/login`, { body: { password: 'nope' }, ip: freshIp() }), T0 + i * 1000);
    const at = T0 + (LOCK.globalFails - 1) * 1000;
    await expectGenericFailure(await call(env, req('POST', `${AP}/api/login`, { body: { password: PW }, ip: freshIp() }), at + 1));
    expect((await call(env, req('POST', `${AP}/api/login`, { body: { password: PW }, ip: freshIp() }), at + LOCK.globalLockMs)).status).toBe(204);
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
    const m = (await (await call(env, req('GET', `${AP}/api/metrics`, { cookie: ck }))).json()) as Record<string, unknown>;
    expect(m).toMatchObject({ confirmed: 4, pending: 1, unsubscribed: 0, beta: 2, todayNew: 3, todayStart: '2026-10-28T16:00:00.000Z' });
    const ch = m.channels as { channel: string; visits: number; confirmed: number; rate: string | null; beta: number }[];
    expect(ch.find((c) => c.channel === 'threads')).toMatchObject({ visits: 4, confirmed: 2, rate: '50.0%', beta: 1 });
    expect(ch.find((c) => c.channel === 'x')).toMatchObject({ visits: 1, confirmed: 1, rate: '100.0%' });
    expect(ch.find((c) => c.channel === 'invite')).toMatchObject({ visits: 2, confirmed: 1, rate: '50.0%' });
    // 邀请排行：邀请人打码、邀请成功人数
    expect(m.inviters).toEqual([{ email: expect.stringMatching(/^o\*\*\*@example\.com$/), count: 1 }]);

    const list = (await (await call(env, req('GET', `${AP}/api/subscribers`, { cookie: ck }))).json()) as {
      total: number;
      items: { email: string; invites: number; beta: boolean; channel: string; inviter: string | null }[];
    };
    expect(list.total).toBe(5);
    expect(list.items.every((x) => /^.\*\*\*@example\.com$/.test(x.email))).toBe(true);
    // 被邀请来的订阅者：多一个邀请人（打码）；其他人没有
    expect(list.items.find((x) => x.email.startsWith('t'))).toBeTruthy();
    expect(list.items.filter((x) => x.channel === 'invite').map((x) => x.inviter)).toEqual([expect.stringMatching(/^o\*\*\*@example\.com$/)]);
    expect(list.items.filter((x) => x.channel !== 'invite').every((x) => x.inviter === null)).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/old\d+@/);
    expect(list.items.find((x) => x.invites === 1)).toBeTruthy();
    const beta = (await (await call(env, req('GET', `${AP}/api/subscribers?beta=1`, { cookie: ck }))).json()) as { total: number; items: { beta: boolean }[] };
    expect(beta.total).toBe(2);
    expect(beta.items.every((x) => x.beta)).toBe(true);
    const pending = (await (await call(env, req('GET', `${AP}/api/subscribers?status=pending`, { cookie: ck }))).json()) as { total: number };
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
    const p1 = (await (await call(env, req('GET', `${AP}/api/subscribers`, { cookie: ck }))).json()) as { items: { id: number }[]; next: number | null; total: number };
    expect(p1.items).toHaveLength(50);
    expect(p1.total).toBe(55);
    const p2 = (await (await call(env, req('GET', `${AP}/api/subscribers?before=${p1.next}`, { cookie: ck }))).json()) as { items: { id: number }[]; next: number | null };
    expect(p2.items).toHaveLength(5);
    expect(p2.next).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x) => x.id)).size).toBe(55);
  });

  it('导出：要再输一次密码（会话有效也要）；错了是通用回答并计入锁定；对了给完整邮箱和邀请人，不含待确认', async () => {
    await resetAuth();
    await db.prepare('DELETE FROM subscribers').run();
    const s = stubFetch();
    vi.stubGlobal('fetch', s.fn);
    const env = testEnv(db);
    const a = uniq('exa');
    const first = await subscribeAndConfirm(env, s.mails, a, { beta: true, src: 'x', cmp: 'w44' });
    const unsubUrl = first.unsubUrl;
    const b = uniq('exb');
    await subscribeAndConfirm(env, s.mails, b, { ref: (first.confirmRes.invite as { code: string }).code });
    await call(env, req('POST', '/api/public/unsubscribe', { body: { token: new URL(unsubUrl).searchParams.get('t') } }));
    await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('exp-pending') }, ip: freshIp() }));
    const ip = freshIp();
    const ck = await login(env, T0, ip);
    expect((await call(env, req('POST', `${AP}/api/export`, { body: {}, ip }))).status).toBe(401); // 没会话
    await expectGenericFailure(await call(env, req('POST', `${AP}/api/export`, { cookie: ck, body: { password: 'not-it' }, ip })));
    expect((await db.prepare('SELECT COUNT(*) AS n FROM auth_fail').first<{ n: number }>())!.n).toBe(1);
    const r = await call(env, req('POST', `${AP}/api/export`, { cookie: ck, body: { password: PW }, ip }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { format: string; environment: string; next: number | null; count: number; items: Record<string, unknown>[] };
    expect(body).toMatchObject({ format: 'qc-waitlist-v2', environment: 'test', next: null, count: 2 });
    expect(body.items[0]).toMatchObject({ email: a, status: 'unsubscribed', beta: true, channel: 'x', cmp: 'w44', inviter: null, invitedCount: 1, lang: 'zh-TW' });
    expect(body.items[1]).toMatchObject({ email: b, status: 'confirmed', beta: false, channel: 'invite', inviter: a, invitedCount: 0 });
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ['email', 'lang', 'status', 'beta', 'channel', 'cmp', 'inviter', 'invitedCount', 'createdAt', 'confirmedAt', 'unsubscribedAt'].sort(),
    );
    // 不再有内部的邀请码、私密密钥
    expect(JSON.stringify(body)).not.toMatch(/inviteCode|invite_key|invite_code/);
    expect(body.items.some((x) => String(x.email).startsWith('exp-pending'))).toBe(false);
  });
});

describe('焦点战', () => {
  it('增删改：主队、客队分开填，时间写法宽松（含日期时间选择器的写法）、自动整理成台湾时间；一次返回全部字段错误；最多 10 场；首页只显示开赛不到 3 小时的，不返回备注', async () => {
    await resetAuth();
    await db.prepare('DELETE FROM featured_matches').run();
    const env = testEnv(db);
    const ck = await login(env);
    const post = (body: unknown) => call(env, req('POST', `${AP}/api/matches`, { cookie: ck, body }));
    const bad = await post({ league: '', home: 'x'.repeat(21), startsAt: '明天' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { fields: unknown[] }).fields).toEqual([
      { field: 'league', code: 'REQUIRED' },
      { field: 'home', code: 'TOO_LONG' },
      { field: 'away', code: 'REQUIRED' },
      { field: 'startsAt', code: 'TIME_FORMAT' },
    ]);
    const ok = await post({ league: ' NBA ', home: '湖人', away: '勇士', startsAt: '2026-11-02T09:30', note: '只給名單頁看' });
    expect(ok.status).toBe(201);
    const m1 = (await ok.json()) as { id: number; startsAt: string; startsAtTw: string; league: string; title: string };
    expect(m1).toMatchObject({ league: 'NBA', home: '湖人', away: '勇士', title: '湖人 vs 勇士', startsAt: '2026-11-02T01:30:00.000Z', startsAtTw: '2026-11-02 09:30' });
    // 已经开赛 3 小时的（首页不显示）
    await post({ league: 'MLB', home: '道奇', away: '洋基', startsAt: '2026-10-29 09:00' });
    const pub = (await (await call(env, req('GET', '/api/public/matches'))).json()) as { items: Record<string, unknown>[] };
    expect(pub.items).toEqual([{ id: m1.id, league: 'NBA', title: '湖人 vs 勇士', startsAt: '2026-11-02T01:30:00.000Z' }]);
    const adminList = (await (await call(env, req('GET', `${AP}/api/matches`, { cookie: ck }))).json()) as { items: { title: string; visible: boolean }[] };
    expect(adminList.items.map((x) => [x.title, x.visible])).toEqual([
      ['道奇 vs 洋基', false],
      ['湖人 vs 勇士', true],
    ]);
    const put = await call(env, req('PUT', `${AP}/api/matches/${m1.id}`, { cookie: ck, body: { league: 'NBA', home: '湖人', away: '塞爾提克', startsAt: '2026/11/02 10:30', note: '例行賽' } }));
    expect(await put.json()).toMatchObject({ title: '湖人 vs 塞爾提克', startsAtTw: '2026-11-02 10:30', note: '例行賽' });
    // 已有 2 场，补到上限
    for (let i = 0; i < MATCH_LIMITS.max - 2; i++) expect((await post({ league: '英超', home: `主${i}`, away: `客${i}`, startsAt: '2026-11-03 00:30' })).status).toBe(201);
    const full = await post({ league: '英超', home: '主', away: '客', startsAt: '2026-11-03 00:30' });
    expect(full.status).toBe(409);
    expect((await call(env, req('DELETE', `${AP}/api/matches/${m1.id}`, { cookie: ck }))).status).toBe(204);
    expect((await call(env, req('DELETE', `${AP}/api/matches/${m1.id}`, { cookie: ck }))).status).toBe(404);
    // 没登录不能改
    expect((await call(env, req('POST', `${AP}/api/matches`, { body: { league: 'a', home: 'b', away: 'c', startsAt: '2026-11-03 00:30' } }))).status).toBe(401);
  });

  it('旧数据（只有对战名、没有主客队）照常显示', async () => {
    await db.prepare('DELETE FROM featured_matches').run();
    await db
      .prepare("INSERT INTO featured_matches (league, title, starts_at, note, created_at, updated_at) VALUES ('NBA', '湖人 vs 勇士', '2026-11-02T01:30:00.000Z', '', ?1, ?1)")
      .bind(new Date(T0).toISOString())
      .run();
    const pub = (await (await call(testEnv(db), req('GET', '/api/public/matches'))).json()) as { items: { title: string }[] };
    expect(pub.items.map((x) => x.title)).toEqual(['湖人 vs 勇士']);
  });

  it('批量导入：逐行检查（行号.字段），有错一行都不写；超过 10 场只留开赛时间最近的 10 场，已开赛超过 3 小时的先去掉；可以先清空', async () => {
    await resetAuth();
    await db.prepare('DELETE FROM featured_matches').run();
    const env = testEnv(db);
    const ck = await login(env);
    const imp = (body: unknown) => call(env, req('POST', `${AP}/api/matches/import`, { cookie: ck, body }));
    // 现有：1 场已开赛很久（首页不显示）、1 场 11/05
    await call(env, req('POST', `${AP}/api/matches`, { cookie: ck, body: { league: 'MLB', home: '舊', away: '賽', startsAt: '2026-10-28 09:00' } }));
    await call(env, req('POST', `${AP}/api/matches`, { cookie: ck, body: { league: 'NBA', home: '現有', away: '一場', startsAt: '2026-11-05 10:00' } }));
    const bad = await imp({ items: [{ league: 'NBA', home: '湖人', away: '勇士', startsAt: '2026-11-02 10:30' }, { league: '', home: '甲', away: '', startsAt: '2026-02-30 10:00' }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { fields: unknown[] }).fields).toEqual([
      { field: '1.league', code: 'REQUIRED' },
      { field: '1.away', code: 'REQUIRED' },
      { field: '1.startsAt', code: 'TIME_INVALID' },
    ]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM featured_matches').first<{ n: number }>())!.n).toBe(2);
    // 导入 n 场（n = 上限 10）：加上现有 1 场共 n+1 场 → 留最近的 n 场（最晚的 11/29 不导入），已开赛的旧场次去掉
    const n = MATCH_LIMITS.max;
    const times = [...Array.from({ length: n - 1 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')} 08:00`), '2026-11-29 08:00'];
    const rows = times.map((t, i) => ({ league: '英超', home: `主${i}`, away: `客${i}`, startsAt: t }));
    const r = await imp({ items: rows });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ imported: n - 1, skipped: 1, removed: 1, total: n, max: n });
    const list = (await (await call(env, req('GET', `${AP}/api/matches`, { cookie: ck }))).json()) as { items: { title: string }[] };
    // 11/05 10:00 的现有场次排在 11/05 08:00（主4）之后
    expect(list.items.map((x) => x.title)).toEqual([
      ...Array.from({ length: 5 }, (_, i) => `主${i} vs 客${i}`),
      '現有 vs 一場',
      ...Array.from({ length: n - 6 }, (_, i) => `主${i + 5} vs 客${i + 5}`),
    ]);
    // 首页只显示开赛时间最近的 6 场
    const pub = (await (await call(env, req('GET', '/api/public/matches'))).json()) as { items: { title: string }[] };
    expect(pub.items.map((x) => x.title)).toEqual(list.items.slice(0, MATCH_LIMITS.shown).map((x) => x.title));
    // 先清空再导入
    const r2 = await imp({ items: rows.slice(0, 2), replace: true });
    expect(await r2.json()).toMatchObject({ imported: 2, total: 2 });
    const list2 = (await (await call(env, req('GET', `${AP}/api/matches`, { cookie: ck }))).json()) as { items: { title: string }[] };
    expect(list2.items.map((x) => x.title)).toEqual(['主0 vs 客0', '主1 vs 客1']);
    // 没有行、没登录
    expect((await imp({ items: [] })).status).toBe(400);
    expect((await call(env, req('POST', `${AP}/api/matches/import`, { body: { items: rows } }))).status).toBe(401);
  });
});
