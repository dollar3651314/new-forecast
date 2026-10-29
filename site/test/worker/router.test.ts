/** 路由底线和健康检查：没有注册、登录、充值、下注、提现的接口；健康检查不泄露密钥。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, newDb, PW, req, testEnv } from './helpers';

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
        expect([401, 404], `${m} ${p}`).toContain(r.status);
        if (!p.startsWith('/api/admin/')) expect(r.status, `${m} ${p}`).toBe(404);
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

describe('健康检查', () => {
  it('列出 db、board、mail、admin、gate 的状态，不含任何密钥', async () => {
    const env = testEnv(db, { VERSION: 'abc123' });
    const r = await call(env, req('GET', '/api/health'));
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({
      status: 'UP',
      environment: 'test',
      version: 'abc123',
      checks: { db: 'ok', board: { status: 'down', sources: [] }, mail: 'ok', admin: 'ok', gate: 'off' },
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
