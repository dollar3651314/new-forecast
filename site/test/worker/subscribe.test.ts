/** 留邮箱、确认、退订、邀请、访问计数（M-6、M-9、M-10）。外部发信用替身，时间固定（C106）。 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RULES } from '../../worker/src/subscribe';
import { call, freshIp, links, newDb, param, req, stubFetch, subscribeAndConfirm, T0, testEnv } from './helpers';

let db: D1Database;
let dispose: () => Promise<void>;
beforeAll(async () => ({ db, dispose } = await newDb()));
afterAll(() => dispose());
afterEach(() => vi.unstubAllGlobals());

const MIN = 60 * 1000;
let n = 0;
const uniq = (p = 'u') => `${p}${++n}-${Date.now()}@Example.com`;

function setup(over = {}) {
  const s = stubFetch();
  vi.stubGlobal('fetch', s.fn);
  return { env: testEnv(db, over), ...s };
}

async function row(email: string) {
  return db.prepare('SELECT * FROM subscribers WHERE email = ?1').bind(email.toLowerCase()).first<Record<string, unknown>>();
}

describe('留邮箱', () => {
  it('新邮箱：回答 check_email，记为待确认，存来源和内测，发一封三个链接的确认邮件', async () => {
    const { env, mails } = setup();
    const email = uniq();
    const r = await call(env, req('POST', '/api/public/subscribe', { body: { email: `  ${email} `, lang: 'zh-TW', beta: true, src: 'threads', cmp: 'tw1', ref: 'nope!' }, ip: freshIp() }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'check_email' });
    const x = await row(email);
    expect(x).toMatchObject({ email: email.toLowerCase(), status: 'PENDING', beta: 1, src: 'threads', cmp: 'tw1', ref: null, channel: 'threads', lang: 'zh-TW' });
    expect(x!.invite_code).toMatch(/^[23456789A-HJKMNP-Z]{6}$/);
    expect(x!.invite_key).toMatch(/^[0-9a-f]{32}$/);
    expect(x!.invite_key).not.toBe(String(x!.invite_code).toLowerCase());
    expect(mails).toHaveLength(1);
    expect(mails[0].body.to).toEqual([email.toLowerCase()]);
    expect(mails[0].auth).toBe('Bearer ci_only_resend_key');
    const [c, i, u] = links(mails[0].body.text);
    expect(c).toBe(`https://www.example.test/confirm?t=${x!.confirm_token}`);
    expect(i).toBe(`https://www.example.test/invite?k=${x!.invite_key}`);
    expect(u).toBe(`https://www.example.test/unsubscribe?t=${x!.unsub_token}`);
    expect(mails[0].body.headers?.['List-Unsubscribe']).toBe(`<${u}>`);
    // 不是正式版：标题带测试标识（C34）
    expect(mails[0].body.subject.startsWith('[測試環境] ')).toBe(true);
  });

  it('邮箱格式不对：400，指出字段和原因；前后端同一套规则', async () => {
    const { env, mails } = setup();
    for (const [email, code] of [
      ['', 'REQUIRED'],
      ['a@b', 'EMAIL_INVALID'],
      ['a b@example.com', 'EMAIL_INVALID'],
    ] as const) {
      const r = await call(env, req('POST', '/api/public/subscribe', { body: { email }, ip: freshIp() }));
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ field: 'email', code }] });
    }
    expect(mails).toHaveLength(0);
  });

  it('已在名单（已确认）的邮箱：回答一模一样，不发信——不透露邮箱是否已在名单', async () => {
    const { env, mails } = setup();
    const email = uniq();
    await subscribeAndConfirm(env, mails, email);
    const before = mails.length;
    const r = await call(env, req('POST', '/api/public/subscribe', { body: { email, lang: 'en' }, ip: freshIp() }), T0 + 60 * MIN);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'check_email' });
    expect(mails.length).toBe(before);
  });

  it('陷阱字段 website 有值：照样回答 check_email，但不记、不发', async () => {
    const { env, mails } = setup();
    const email = uniq('bot');
    const r = await call(env, req('POST', '/api/public/subscribe', { body: { email, website: 'http://spam' }, ip: freshIp() }));
    expect(await r.json()).toEqual({ status: 'check_email' });
    expect(await row(email)).toBeNull();
    expect(mails).toHaveLength(0);
  });

  it('同一 IP 每小时 10 次：第 11 次 429（带 cooldownSeconds），下一个小时窗口恢复，别的 IP 不受影响', async () => {
    const { env } = setup();
    const ip = freshIp();
    // 窗口从整点开始：T0 是整点
    for (let i = 0; i < RULES.ipPerHour; i++) {
      const r = await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('rl') }, ip }), T0 + i * 1000);
      expect(r.status).toBe(200);
    }
    const r11 = await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('rl') }, ip }), T0 + 30 * MIN);
    expect(r11.status).toBe(429);
    expect(await r11.json()).toMatchObject({ code: 'RATE_LIMITED', cooldownSeconds: 30 * 60 });
    expect(r11.headers.get('Retry-After')).toBe('1800');
    expect((await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('rl') }, ip: freshIp() }), T0 + 30 * MIN)).status).toBe(200);
    // 窗口最后 1 毫秒仍是同一个窗口；整点那一毫秒起是新窗口（C106）
    expect((await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('rl') }, ip }), T0 + 60 * MIN - 1)).status).toBe(429);
    expect((await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('rl') }, ip }), T0 + 60 * MIN)).status).toBe(200);
  });

  it('待确认的邮箱再留：10 分钟内不重发；满 10 分钟那一毫秒起可以再发（同一个确认链接）；最多 5 封', async () => {
    const { env, mails } = setup();
    const email = uniq('re');
    const send = (t: number) => call(env, req('POST', '/api/public/subscribe', { body: { email }, ip: freshIp() }), t);
    await send(T0);
    expect(mails).toHaveLength(1);
    await send(T0 + 10 * MIN - 1);
    expect(mails).toHaveLength(1);
    await send(T0 + 10 * MIN);
    expect(mails).toHaveLength(2);
    expect(links(mails[1].body.text)[0]).toBe(links(mails[0].body.text)[0]);
    let t = T0 + 10 * MIN;
    for (let i = 0; i < 6; i++) {
      t += 10 * MIN;
      await send(t);
    }
    expect(mails).toHaveLength(RULES.maxConfirmSends);
    expect((await row(email))!.confirm_sends).toBe(RULES.maxConfirmSends);
  });

  it('发信未开通（没填 RESEND_API_KEY）：留邮箱照常回答、记下，不调用 Resend，不报错', async () => {
    const { env, calls } = setup({ RESEND_API_KEY: '' });
    const email = uniq('nokey');
    const r = await call(env, req('POST', '/api/public/subscribe', { body: { email }, ip: freshIp() }));
    expect(r.status).toBe(200);
    expect(await row(email)).toMatchObject({ status: 'PENDING' });
    expect(calls).toHaveLength(0);
    const h = await (await call(env, req('GET', '/api/health'))).json();
    expect(h).toMatchObject({ status: 'UP', checks: { mail: 'not_configured' } });
  });

  it('Resend 出错或超时：留邮箱的回答不受影响（发信在回答之后）', async () => {
    const s = stubFetch({}, 500);
    vi.stubGlobal('fetch', s.fn);
    const env = testEnv(db);
    const r = await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('r500') }, ip: freshIp() }));
    expect(r.status).toBe(200);
  });

  it('写接口只接受本站页面发起的 JSON', async () => {
    const { env } = setup();
    const cross = await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq() }, headers: { Origin: 'https://evil.example' } }));
    expect(cross.status).toBe(403);
    const form = await call(env, new Request('https://www.example.test/api/public/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.co' }));
    expect(form.status).toBe(400);
  });
});

describe('确认', () => {
  it('打开链接本身不会确认（确认只有 POST）；按确认后才是 CONFIRMED，返回邀请码和私密密钥', async () => {
    const { env, mails } = setup();
    const email = uniq('c');
    await call(env, req('POST', '/api/public/subscribe', { body: { email, beta: true }, ip: freshIp() }));
    const confirmUrl = links(mails[0].body.text)[0];
    // 浏览器打开 /confirm?t=… 只拿到页面（静态资源），状态不变
    const page = await call(env, new Request(confirmUrl));
    expect(await page.text()).toBe('asset:/confirm');
    expect((await row(email))!.status).toBe('PENDING');
    // GET 确认接口不存在
    expect((await call(env, req('GET', `/api/public/confirm?t=${param(confirmUrl, 't')}`))).status).toBe(404);
    const r = await call(env, req('POST', '/api/public/confirm', { body: { token: param(confirmUrl, 't') } }), T0 + 5 * MIN);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { status: string; beta: boolean; invite: { code: string; key: string; link: string; count: number } };
    const x = await row(email);
    expect(body).toMatchObject({ status: 'confirmed', lang: 'zh-TW', beta: true });
    expect(body.invite).toEqual({ code: x!.invite_code, key: x!.invite_key, link: `https://www.example.test/?ref=${x!.invite_code}`, count: 0 });
    expect(x).toMatchObject({ status: 'CONFIRMED', confirmed_at: new Date(T0 + 5 * MIN).toISOString() });
    // 重复确认：没有效果，确认时间不变
    await call(env, req('POST', '/api/public/confirm', { body: { token: param(confirmUrl, 't') } }), T0 + 9 * MIN);
    expect((await row(email))!.confirmed_at).toBe(new Date(T0 + 5 * MIN).toISOString());
  });

  it('确认链接 7 天有效：恰好满 7 天那一毫秒还能确认，再晚 1 毫秒 410', async () => {
    const { env, mails } = setup();
    const a = uniq('exp');
    const b = uniq('exp');
    await call(env, req('POST', '/api/public/subscribe', { body: { email: a }, ip: freshIp() }));
    await call(env, req('POST', '/api/public/subscribe', { body: { email: b }, ip: freshIp() }));
    const ta = param(links(mails[0].body.text)[0], 't');
    const tb = param(links(mails[1].body.text)[0], 't');
    expect((await call(env, req('POST', '/api/public/confirm', { body: { token: ta } }), T0 + RULES.confirmValidMs)).status).toBe(200);
    const late = await call(env, req('POST', '/api/public/confirm', { body: { token: tb } }), T0 + RULES.confirmValidMs + 1);
    expect(late.status).toBe(410);
    expect(await late.json()).toMatchObject({ code: 'LINK_EXPIRED' });
  });

  it('随机串不对：404（和"暂时出错"分开）', async () => {
    const { env } = setup();
    for (const token of ['f'.repeat(32), 'xyz', 123]) {
      const r = await call(env, req('POST', '/api/public/confirm', { body: { token } }));
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ code: 'LINK_INVALID' });
    }
  });
});

describe('退订', () => {
  it('不用登录，按按钮退订；重复也成功；退订后再留邮箱重新走确认（新确认链接，邀请码不变）', async () => {
    const { env, mails } = setup();
    const email = uniq('un');
    const { unsubUrl } = await subscribeAndConfirm(env, mails, email);
    const code = (await row(email))!.invite_code;
    const r = await call(env, req('POST', '/api/public/unsubscribe', { body: { token: param(unsubUrl, 't') } }), T0 + MIN);
    expect(await r.json()).toEqual({ status: 'unsubscribed', lang: 'zh-TW' });
    expect(await row(email)).toMatchObject({ status: 'UNSUBSCRIBED' });
    expect((await call(env, req('POST', '/api/public/unsubscribe', { body: { token: param(unsubUrl, 't') } }))).status).toBe(200);
    const before = mails.length;
    await call(env, req('POST', '/api/public/subscribe', { body: { email }, ip: freshIp() }), T0 + 20 * MIN);
    expect(mails.length).toBe(before + 1);
    const x = await row(email);
    expect(x).toMatchObject({ status: 'PENDING', invite_code: code });
    expect(links(mails[before].body.text)[0]).not.toBe(links(mails[0].body.text)[0]);
  });

  it('退订码不对：404', async () => {
    const { env } = setup();
    expect((await call(env, req('POST', '/api/public/unsubscribe', { body: { token: '0'.repeat(32) } }))).status).toBe(404);
  });
});

describe('邀请（M-10）', () => {
  it('?ref=邀请码 进来并确认的算一次邀请；只留不确认的不算；本人用私密链接看人数，不需要登录', async () => {
    const { env, mails } = setup();
    const owner = uniq('owner');
    const { inviteUrl, confirmRes } = await subscribeAndConfirm(env, mails, owner);
    const code = (confirmRes.invite as { code: string }).code;
    // 两个朋友：一个确认、一个只留不确认；邀请码大小写不论
    await subscribeAndConfirm(env, mails, uniq('friend'), { ref: code.toLowerCase(), src: 'x' });
    await call(env, req('POST', '/api/public/subscribe', { body: { email: uniq('lazy'), ref: code }, ip: freshIp() }));
    const key = param(inviteUrl, 'k');
    const r = await call(env, req('GET', `/api/public/invite?k=${key}`));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'confirmed', invite: { code, count: 1, link: `https://www.example.test/?ref=${code}` } });
    // 用邀请码当密钥查不到（私密链接的密钥和邀请码不同）
    expect((await call(env, req('GET', `/api/public/invite?k=${code}`))).status).toBe(404);
  });

  it('没确认的人：私密页只返回状态，不给邀请码；别人拿他的码进来不算邀请', async () => {
    const { env, mails } = setup();
    const email = uniq('pend');
    await call(env, req('POST', '/api/public/subscribe', { body: { email }, ip: freshIp() }));
    const key = param(links(mails[0].body.text)[1], 'k');
    const body = await (await call(env, req('GET', `/api/public/invite?k=${key}`))).json();
    expect(body).toEqual({ status: 'pending', lang: 'zh-TW' });
    const code = (await row(email))!.invite_code as string;
    const f = uniq('f2');
    await subscribeAndConfirm(env, mails, f, { ref: code });
    expect((await row(f))!.channel).toBe('');
  });
});

describe('访问计数（M-9 的分母）', () => {
  it('按天 + 来源 + cmp 计数；ref 是有效邀请码时记为 invite；同一 IP 每小时 30 次以后不计也不报错', async () => {
    const { env, mails } = setup();
    const { confirmRes } = await subscribeAndConfirm(env, mails, uniq('vis'));
    const code = (confirmRes.invite as { code: string }).code;
    const ip = freshIp();
    const v = (body: unknown, i = ip) => call(env, req('POST', '/api/public/visit', { body, ip: i }));
    expect((await v({ src: 'x', cmp: 'w1' })).status).toBe(204);
    await v({ ref: code });
    await v({});
    const rows = (await db.prepare('SELECT channel, cmp, count FROM visit_daily WHERE day = ?1 ORDER BY channel, cmp').bind('2026-10-29').all()).results;
    expect(rows).toEqual(expect.arrayContaining([{ channel: 'x', cmp: 'w1', count: 1 }, { channel: 'invite', cmp: '', count: 1 }, { channel: '', cmp: '', count: 1 }]));
    const ip2 = freshIp();
    for (let i = 0; i < RULES.visitIpPerHour + 5; i++) expect((await v({ src: 'flood' }, ip2)).status).toBe(204);
    const f = await db.prepare("SELECT count FROM visit_daily WHERE channel = 'flood'").first<{ count: number }>();
    expect(f!.count).toBe(RULES.visitIpPerHour);
  });
});
