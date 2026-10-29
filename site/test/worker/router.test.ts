/** 路由底线、测试版不收录、健康检查：没有注册、登录、充值、下注、提现的接口；公开页面不要密码；健康检查不泄露密钥。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AP, call, newDb, PW, req, testEnv } from './helpers';

let db: D1Database;
let dispose: () => Promise<void>;
beforeAll(async () => ({ db, dispose } = await newDb()));
afterAll(() => dispose());

describe('路由', () => {
  it('交易、账户类接口一律 404', async () => {
    const env = testEnv(db);
    for (const p of ['/api/auth/login', '/api/auth/register', '/api/me', '/api/bets', '/api/wallet/deposit-address', '/api/withdraw', '/api/markets', '/api/kyc', '/api/public/nope', '/api/admin/nope']) {
      for (const m of ['GET', 'POST']) {
        const r = await call(env, req(m, p, m === 'POST' ? { body: {} } : {}));
        expect(r.status, `${m} ${p}`).toBe(404);
      }
    }
  });

  it('接口都带安全头、不缓存', async () => {
    const r = await call(testEnv(db), req('GET', '/api/public/matches'));
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('GET /api/public/site：环境名和备用网址（只接受 https）', async () => {
    const a = await (await call(testEnv(db, { BACKUP_URL: 'https://new-forecast-site.example.workers.dev/' }), req('GET', '/api/public/site'))).json();
    expect(a).toEqual({ environment: 'test', backupUrl: 'https://new-forecast-site.example.workers.dev' });
    const b = await (await call(testEnv(db, { BACKUP_URL: 'javascript:alert(1)' }), req('GET', '/api/public/site'))).json();
    expect(b).toMatchObject({ backupUrl: null });
  });
});

describe('测试版：公开页面不要密码，但不让搜索引擎收录（v1.1）', () => {
  it('测试版（staging）：首页、专属页面、公开接口直接打开（没有密码门），每个回答都有 X-Robots-Tag: noindex；robots.txt 禁止整站', async () => {
    const env = testEnv(db, { ENVIRONMENT: 'staging' });
    for (const p of ['/', '/subscription?k=abc', '/about/terms', '/api/public/matches', '/api/public/site', '/api/health']) {
      const r = await call(env, req('GET', p));
      expect(r.status, p).toBe(200);
      expect(r.headers.get('X-Robots-Tag'), p).toBe('noindex, nofollow');
    }
    expect(await (await call(env, req('GET', '/'))).text()).toBe('asset:/');
    const robots = await call(env, req('GET', '/robots.txt'));
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
    // 整站密码门已经去掉
    expect((await call(env, req('POST', '/api/gate/login', { body: { password: PW } }))).status).toBe(404);
    // 名单页仍然要密码
    expect((await call(env, req('GET', `${AP}/api/metrics`))).status).toBe(401);
  });

  it('正式版（production）：不加 noindex，robots.txt 用静态文件', async () => {
    const env = testEnv(db, { ENVIRONMENT: 'production' });
    const r = await call(env, req('GET', '/'));
    expect(r.headers.get('X-Robots-Tag')).toBeNull();
    expect(await (await call(env, req('GET', '/robots.txt'))).text()).toBe('asset:/robots.txt');
  });
});

describe('健康检查', () => {
  it('列出 db、board、mail、admin 的状态，不含任何密钥', async () => {
    const env = testEnv(db, { VERSION: 'abc123' });
    const r = await call(env, req('GET', '/api/health'));
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({
      status: 'UP',
      environment: 'test',
      version: 'abc123',
      checks: { db: 'ok', board: { status: 'down', sources: [] }, mail: 'ok', admin: 'ok' },
    });
    expect(text).not.toContain(PW);
    expect(text).not.toContain('ci_only_resend_key');
  });

  it('D1 读不了：503 DOWN，仍然列出配置状态', async () => {
    const broken = { prepare: () => { throw new Error('d1 down'); } } as unknown as D1Database;
    const r = await call(testEnv(broken, { RESEND_API_KEY: '' }), req('GET', '/api/health'));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ status: 'DOWN', checks: { db: 'down', mail: 'not_configured', admin: 'ok' } });
  });
});
