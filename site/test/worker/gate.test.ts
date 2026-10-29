/** 测试版整站密码门（SITE_GATE = on）。 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, cookieFrom, freshIp, newDb, PW, req, T0, testEnv } from './helpers';

let db: D1Database;
let dispose: () => Promise<void>;
beforeAll(async () => ({ db, dispose } = await newDb()));
afterAll(() => dispose());

describe('SITE_GATE = on', () => {
  it('没输密码：页面给 401 密码页（顶部有测试环境标识条），接口 401，健康检查照常', async () => {
    const env = testEnv(db, { SITE_GATE: 'on', ENVIRONMENT: 'staging' });
    for (const p of ['/', '/confirm?t=abc', '/about/terms', '/assets/index.js', '/admin']) {
      const r = await call(env, req('GET', p));
      expect(r.status, p).toBe(401);
      const html = await r.text();
      expect(html).toContain('測試環境');
      expect(html).toContain('type="password"');
      expect(r.headers.get('X-Robots-Tag')).toBe('noindex');
    }
    for (const [m, p] of [
      ['GET', '/api/public/board'],
      ['POST', '/api/public/subscribe'],
      ['POST', '/api/admin/login'],
    ]) {
      const r = await call(env, req(m, p, m === 'POST' ? { body: { email: 'a@b.co', password: PW } } : {}));
      expect(r.status, p).toBe(401);
      expect(await r.json()).toMatchObject({ code: 'GATE_REQUIRED' });
    }
    const h = await call(env, req('GET', '/api/health'));
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ environment: 'staging', checks: { gate: 'on' } });
  });

  it('输对密码：发整站 Cookie（HttpOnly、Secure、Path=/、12 小时），之后页面和接口照常；错了 401 并计入锁定', async () => {
    const env = testEnv(db, { SITE_GATE: 'on' });
    const ip = freshIp();
    const wrong = await call(env, req('POST', '/api/gate/login', { body: { password: 'nope' }, ip }));
    expect(wrong.status).toBe(401);
    const r = await call(env, req('POST', '/api/gate/login', { body: { password: PW }, ip }));
    expect(r.status).toBe(204);
    const set = r.headers.getSetCookie()[0];
    expect(set).toMatch(/^qc_gate=\d+\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; Max-Age=43200; SameSite=Lax$/);
    const ck = cookieFrom(r, 'qc_gate');
    expect(await (await call(env, req('GET', '/', { cookie: ck }))).text()).toBe('asset:/');
    expect((await call(env, req('GET', '/api/public/board', { cookie: ck }))).status).toBe(200);
    // 名单页在密码门后面仍要单独登录
    expect((await call(env, req('GET', '/api/admin/session', { cookie: ck }))).status).toBe(401);
    // 过期
    expect((await call(env, req('GET', '/', { cookie: ck }), T0 + 12 * 3600_000)).status).toBe(401);
  });

  it('密码没开通（少于 16 个字符）：整站 503，不开放', async () => {
    const env = testEnv(db, { SITE_GATE: 'on', ADMIN_PASSWORD: 'short' });
    expect((await call(env, req('GET', '/'))).status).toBe(503);
    expect((await call(env, req('POST', '/api/gate/login', { body: { password: 'short' } }))).status).toBe(503);
    expect((await call(env, req('GET', '/api/health'))).status).toBe(200);
  });

  it('SITE_GATE 没设（正式版）：页面直接给，/api/gate/login 不存在', async () => {
    const env = testEnv(db);
    expect(await (await call(env, req('GET', '/'))).text()).toBe('asset:/');
    expect((await call(env, req('POST', '/api/gate/login', { body: { password: PW } }))).status).toBe(404);
  });
});
