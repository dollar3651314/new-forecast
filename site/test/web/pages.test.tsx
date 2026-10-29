/** 页面组件：首页（电脑两栏 / 手机单栏）、留邮箱表单（成功状态）、专属页面（打开就确认、刷新、已退订、过期、无效）、语言切换、焦点战空状态和出错、名单页（通用登录失败提示、来源名字、邀请人、内测 0 人说明、焦点战下拉和日期时间选择器、导入预览）。 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdminApp } from '../../web/src/admin/AdminApp';
import { App } from '../../web/src/App';
import { I18nProvider } from '../../web/src/i18n';
import { setWidth } from './setup';

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown } | Promise<never>;

/** 替身 fetch：按路径给结果，记下所有请求 */
function stubApi(routes: Record<string, Handler | { status: number; body?: unknown }>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (u: string, init: RequestInit = {}) => {
    const path = u.split('?')[0];
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const h = routes[path] ?? routes[`${init.method ?? 'GET'} ${path}`];
    const r = typeof h === 'function' ? await h(u, init) : (h ?? { status: 404, body: { code: 'NOT_FOUND' } });
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

const PUBLIC = {
  '/api/public/site': { status: 200, body: { environment: 'production', backupUrl: 'https://new-forecast-site.demo.workers.dev' } },
  '/api/public/matches': { status: 200, body: { items: [{ id: 1, league: 'NBA', title: '湖人 vs 勇士', startsAt: '2026-11-02T02:30:00.000Z' }] } },
  '/api/public/board': {
    status: 200,
    body: { btc: { available: true, price: '81544.30', hours: 24, up: 15, down: 9, upPct: '62.5', downPct: '37.5', source: 'OKX', updatedAt: '2026-10-29T04:00:00.000Z' } },
  },
  '/api/public/visit': { status: 204 },
};

function at(path: string) {
  window.history.replaceState(null, '', path);
}

function renderApp(path: string, lang?: 'zh-TW' | 'zh-CN' | 'en') {
  at(path);
  return render(
    <I18nProvider initial={lang}>
      <App pathname={path.split('?')[0]} />
    </I18nProvider>,
  );
}

describe('首页', () => {
  it('电脑版两栏：返奖率对照、留邮箱、焦点战（真实接口的数据）、BTC 每小时场、怎么玩算例、充值提醒、常见问题、社媒、备用网址', async () => {
    setWidth(1440);
    const calls = stubApi(PUBLIC);
    const { container } = renderApp('/?src=threads&cmp=w1', 'zh-TW');
    expect(container.querySelector('[data-layout="desktop"]')).toBeTruthy();
    expect(screen.getByRole('group', { name: '返獎率對照' })).toHaveTextContent('≤78%');
    expect(screen.getByRole('group', { name: '返獎率對照' })).toHaveTextContent('≈97.5%');
    expect(screen.getByText(/《運動彩券發行條例》第 6 條/)).toBeInTheDocument();
    expect(await screen.findByText('湖人 vs 勇士')).toBeInTheDocument();
    expect(screen.getByText('11/02（一）10:30')).toBeInTheDocument();
    // 焦点战卡片只有联赛、对战、开赛时间：没有"上线后这里显示两边的人数和机率"那行字
    expect(screen.getByTestId('match')).toHaveTextContent(/^NBA湖人 vs 勇士11\/02（一）10:30$/);
    expect(container.textContent).not.toMatch(/上線後這裡顯示/);
    expect(await screen.findByText('現價 81,544.30 USDT')).toBeInTheDocument();
    expect(screen.getByText('過去 24 小時：漲 15 小時、跌 9 小時')).toBeInTheDocument();
    expect(screen.getByText(/OKX 公開行情/)).toBeInTheDocument();
    expect(screen.getByTestId('calc')).toHaveTextContent('100 ＋ 380 × 100 ÷ 600 ＝ 163.33 USDT');
    expect(screen.getByTestId('calc')).toHaveTextContent('1,000 裡有 980（98%）');
    expect(screen.getByText('用 BEP20 充值最省')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '@QuickCome6' })[0]).toHaveAttribute('href', 'https://x.com/QuickCome6');
    expect(screen.getByRole('link', { name: '@quickcome6' })).toHaveAttribute('href', 'https://www.threads.com/@quickcome6');
    expect(await screen.findByTestId('backup-url')).toHaveTextContent('new-forecast-site.demo.workers.dev');
    expect(screen.queryByTestId('env-banner')).toBeNull();
    // 没有注册、登录、充值、下注入口
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('href')).not.toMatch(/\/(login|register|signup|deposit|wallet|bet|markets)/);
    // 访问计数带上来源
    await waitFor(() => expect(calls.find((c) => c.url === '/api/public/visit')?.body).toEqual({ src: 'threads', cmp: 'w1', ref: null }));
  });

  it('手机版单栏：标题、对照条之后紧接着留邮箱，焦点战是一行一场的列表', async () => {
    setWidth(390);
    stubApi(PUBLIC);
    const { container } = renderApp('/', 'zh-TW');
    const hero = container.querySelector('[data-layout="mobile"]')!;
    expect(hero).toBeTruthy();
    const order = [...hero.children].map((e) => e.className || e.tagName);
    expect(order.indexOf('bars-only')).toBeLessThan(order.indexOf('form'));
    await screen.findByText('湖人 vs 勇士');
    expect(container.querySelector('.list [data-testid="match"]')).toBeTruthy();
    expect(container.querySelector('.games')).toBeNull();
    setWidth(1440);
  });

  it('焦点战为空和读取出错：分别有明确的显示，出错可以重试', async () => {
    let fail = true;
    stubApi({ ...PUBLIC, '/api/public/matches': () => (fail ? { status: 500 } : { status: 200, body: { items: [] } }) });
    renderApp('/', 'zh-TW');
    expect(await screen.findByText('焦點戰暫時讀不到。')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    expect(await screen.findByTestId('matches-empty')).toHaveTextContent('這週的焦點戰還在挑');
  });

  it('BTC 行情没取到：写"暂时取不到"', async () => {
    stubApi({ ...PUBLIC, '/api/public/board': { status: 200, body: { btc: { available: false } } } });
    renderApp('/', 'zh-TW');
    expect(await screen.findByText(/BTC 行情暫時取不到/)).toBeInTheDocument();
  });

  it('测试环境：顶部有标识条', async () => {
    stubApi({ ...PUBLIC, '/api/public/site': { status: 200, body: { environment: 'staging', backupUrl: null } } });
    renderApp('/', 'zh-TW');
    expect(await screen.findByTestId('env-banner')).toHaveTextContent('測試環境');
    expect(screen.queryByTestId('backup-url')).toBeNull();
  });
});

describe('留邮箱表单', () => {
  it('送出前就用同一套规则标出错误；正确时带上语言、内测（选填）、来源、陷阱字段送出，显示明确的成功状态', async () => {
    const calls = stubApi({ ...PUBLIC, 'POST /api/public/subscribe': { status: 200, body: { status: 'check_email' } } });
    renderApp('/?ref=K7Q2XA', 'zh-TW');
    fireEvent.click(screen.getByRole('button', { name: '上線時通知我' }));
    expect(await screen.findByText('請填寫電子信箱。')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('電子信箱'), { target: { value: 'a@b' } });
    fireEvent.click(screen.getByRole('button', { name: '上線時通知我' }));
    expect(await screen.findByText(/電子信箱格式不對/)).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/public/subscribe')).toBe(false);
    fireEvent.change(screen.getByLabelText('電子信箱'), { target: { value: ' you@example.com ' } });
    expect(screen.getByRole('checkbox', { name: /我願意參加內測.*（選填）/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /我願意參加內測/ }));
    fireEvent.click(screen.getByRole('button', { name: '上線時通知我' }));
    const done = await screen.findByTestId('subscribe-done');
    expect(done).toHaveTextContent('確認信已寄出');
    expect(done).toHaveTextContent('請到信箱點連結完成訂閱');
    expect(done).toHaveTextContent('you@example.com');
    // "换一个信箱"只是一个不起眼的文字链接，不是主按钮
    expect(screen.getByTestId('subscribe-again')).toHaveClass('linkbtn');
    expect(screen.getByTestId('subscribe-again')).not.toHaveClass('btn');
    // 电脑 / 手机排版切换（窗口缩放、手机转向）：成功状态不能丢
    act(() => setWidth(390));
    expect(await screen.findByTestId('subscribe-done')).toHaveTextContent('確認信已寄出');
    act(() => setWidth(1440));
    expect(await screen.findByTestId('subscribe-done')).toHaveTextContent('you@example.com');
    expect(calls.find((c) => c.url === '/api/public/subscribe')!.body).toEqual({ email: 'you@example.com', lang: 'zh-TW', beta: true, website: '', src: null, cmp: null, ref: 'K7Q2XA' });
  });

  it('不勾内测也能送出（选填），beta = false', async () => {
    const calls = stubApi({ ...PUBLIC, 'POST /api/public/subscribe': { status: 200, body: { status: 'check_email' } } });
    renderApp('/', 'zh-TW');
    fireEvent.change(screen.getByLabelText('電子信箱'), { target: { value: 'b@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '上線時通知我' }));
    await screen.findByTestId('subscribe-done');
    expect(calls.find((c) => c.url === '/api/public/subscribe')!.body).toMatchObject({ beta: false });
  });

  it('太频繁：显示几分钟后再试；断网：显示检查网络', async () => {
    let mode: 'rl' | 'net' = 'rl';
    stubApi({
      ...PUBLIC,
      'POST /api/public/subscribe': () => (mode === 'rl' ? { status: 429, body: { code: 'RATE_LIMITED', cooldownSeconds: 600 } } : Promise.reject(new TypeError('offline'))),
    });
    renderApp('/', 'zh-TW');
    fireEvent.change(screen.getByLabelText('電子信箱'), { target: { value: 'you@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '上線時通知我' }));
    expect(await screen.findByText('送出太頻繁了，請 10 分鐘後再試。')).toBeInTheDocument();
    mode = 'net';
    fireEvent.click(screen.getByRole('button', { name: '上線時通知我' }));
    expect(await screen.findByText(/暫時無法連線/)).toBeInTheDocument();
  });
});

describe('语言切换', () => {
  it('切换后整页换语言，并记住（localStorage qc.lang）', async () => {
    stubApi(PUBLIC);
    renderApp('/', 'zh-TW');
    fireEvent.change(screen.getByRole('combobox', { name: '語言' }), { target: { value: 'en' } });
    expect(await screen.findByRole('button', { name: 'Notify me at launch' })).toBeInTheDocument();
    expect(localStorage.getItem('qc.lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'zh-CN' } });
    expect(await screen.findByRole('button', { name: '上线时通知我' })).toBeInTheDocument();
  });
});

const KEY = 'a'.repeat(32);
const CONFIRMED = { status: 'confirmed', lang: 'zh-TW', beta: true, invite: { code: 'K7Q2XA', link: 'https://www.quickcome.online/?ref=K7Q2XA', count: 2 } };

describe('专属页面 /subscription', () => {
  it('打开就自动确认（脚本 POST，不用按按钮）：显示订阅成功、内测一句、充值提醒、邀请链接和人数；没有"打开我的专属页面"小字链接', async () => {
    const calls = stubApi({ ...PUBLIC, 'POST /api/public/subscription': { status: 200, body: CONFIRMED } });
    const { container } = renderApp(`/subscription?k=${KEY}`, 'zh-TW');
    expect(await screen.findByTestId('sub-ok')).toHaveTextContent('訂閱成功');
    expect(calls.filter((c) => c.url === '/api/public/subscription')).toEqual([{ url: '/api/public/subscription', method: 'POST', body: { key: KEY } }]);
    expect(screen.queryByRole('button', { name: '確認訂閱' })).toBeNull();
    expect(screen.getByTestId('sub-ok')).toHaveTextContent('願意參加內測');
    expect(screen.getByTestId('deposit-tip')).toHaveTextContent('BEP20');
    expect(screen.getByTestId('invite-link')).toHaveTextContent('https://www.quickcome.online/?ref=K7Q2XA');
    expect(screen.getByTestId('invite-count')).toHaveTextContent('你已邀請 2 人');
    expect(screen.getByTestId('invite-copy')).toHaveTextContent('複製連結');
    expect(container.textContent).not.toMatch(/打開我的專屬頁面/);
  });

  it('刷新（重新打开）：还是同一个页面，人数是最新的', async () => {
    let count = 0;
    stubApi({ ...PUBLIC, 'POST /api/public/subscription': () => ({ status: 200, body: { ...CONFIRMED, invite: { ...CONFIRMED.invite, count } } }) });
    const first = renderApp(`/subscription?k=${KEY}`, 'zh-TW');
    expect(await screen.findByTestId('invite-count')).toHaveTextContent('你已邀請 0 人');
    first.unmount();
    count = 1;
    renderApp(`/subscription?k=${KEY}`, 'zh-TW');
    expect(await screen.findByTestId('invite-count')).toHaveTextContent('你已邀請 1 人');
    expect(screen.getByTestId('sub-ok')).toHaveTextContent('訂閱成功');
  });

  it('取消订阅（先问一次）→ 显示已退订和"重新訂閱"；按重新订阅 → 回到订阅成功', async () => {
    const calls = stubApi({
      ...PUBLIC,
      'POST /api/public/subscription': { status: 200, body: CONFIRMED },
      'POST /api/public/subscription/unsubscribe': { status: 200, body: { status: 'unsubscribed', lang: 'zh-TW', beta: true } },
      'POST /api/public/subscription/resubscribe': { status: 200, body: CONFIRMED },
    });
    renderApp(`/subscription?k=${KEY}`, 'zh-TW');
    fireEvent.click(await screen.findByTestId('sub-unsub-open'));
    expect(calls.some((c) => c.url.endsWith('/unsubscribe'))).toBe(false);
    fireEvent.click(screen.getByTestId('sub-unsub-yes'));
    expect(await screen.findByTestId('sub-unsubscribed')).toHaveTextContent('你已經取消訂閱');
    expect(screen.queryByTestId('invite-panel')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新訂閱' }));
    expect(await screen.findByTestId('sub-ok')).toHaveTextContent('訂閱成功');
  });

  it('打开时已经是已退订：直接显示已退订', async () => {
    stubApi({ ...PUBLIC, 'POST /api/public/subscription': { status: 200, body: { status: 'unsubscribed', lang: 'zh-TW', beta: false } } });
    renderApp(`/subscription?k=${KEY}`, 'zh-TW');
    expect(await screen.findByTestId('sub-unsubscribed')).toHaveTextContent('重新訂閱');
  });

  it('链接过期（410）：说明 + "重新寄送确认信"；寄出后提示；10 分钟内再按提示几分钟后再试', async () => {
    let resend: { status: number; body?: unknown } = { status: 200, body: { status: 'pending', lang: 'zh-TW', beta: false, sent: true } };
    stubApi({ ...PUBLIC, 'POST /api/public/subscription': { status: 410, body: { code: 'LINK_EXPIRED' } }, 'POST /api/public/subscription/resend': () => resend });
    renderApp(`/subscription?k=${KEY}`, 'zh-TW');
    expect(await screen.findByTestId('sub-expired')).toHaveTextContent('這個連結已經超過 7 天');
    fireEvent.click(screen.getByTestId('sub-resend'));
    expect(await screen.findByText(/已重新寄出/)).toBeInTheDocument();
    resend = { status: 429, body: { code: 'RATE_LIMITED', cooldownSeconds: 540 } };
    fireEvent.click(screen.getByTestId('sub-resend'));
    expect(await screen.findByText('剛剛已經寄過了，請 9 分鐘後再試。')).toBeInTheDocument();
  });

  it('链接无效（404）：说明 + 回首页重新留信箱；网址缺密钥同样处理', async () => {
    stubApi({ ...PUBLIC, 'POST /api/public/subscription': { status: 404, body: { code: 'LINK_INVALID' } } });
    renderApp(`/subscription?k=${KEY}`, 'zh-TW');
    expect(await screen.findByTestId('sub-invalid')).toHaveTextContent('這個連結無效');
    expect(screen.getByRole('link', { name: '回首頁重新留信箱' })).toHaveAttribute('href', '/');
    renderApp('/subscription', 'zh-TW');
    expect(screen.getAllByTestId('sub-invalid').length).toBe(2);
  });

  it('暂时出错：说原因并可以重试（不说"链接无效"）', async () => {
    let fail = true;
    stubApi({ ...PUBLIC, 'POST /api/public/subscription': () => (fail ? { status: 500 } : { status: 200, body: CONFIRMED }) });
    renderApp(`/subscription?k=${KEY}`, 'zh-TW');
    expect(await screen.findByText(/伺服器暫時出錯/)).toBeInTheDocument();
    expect(screen.queryByText(/無效/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重試' }));
    expect(await screen.findByTestId('sub-ok')).toBeInTheDocument();
  });

  it('英文：同一个页面', async () => {
    stubApi({ ...PUBLIC, 'POST /api/public/subscription': { status: 200, body: CONFIRMED } });
    renderApp(`/subscription?k=${KEY}`, 'en');
    expect(await screen.findByTestId('sub-ok')).toHaveTextContent('You are subscribed');
    expect(screen.getByTestId('invite-count')).toHaveTextContent('You have invited 2');
  });
});

describe('旧链接、退订页、法律页', () => {
  it('旧的确认链接 /confirm?t=：页面脚本换密钥（不显示按钮）；无效时说明', async () => {
    const calls = stubApi({ ...PUBLIC, 'POST /api/public/confirm': { status: 404, body: { code: 'LINK_INVALID' } } });
    renderApp(`/confirm?t=${'1'.repeat(32)}`, 'zh-TW');
    expect(await screen.findByTestId('sub-invalid')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/public/confirm')!.body).toEqual({ token: '1'.repeat(32) });
    expect(screen.queryByRole('button', { name: '確認訂閱' })).toBeNull();
  });

  it('退订页：按按钮才退订；退订后给"重新订阅"入口（专属页面）', async () => {
    const calls = stubApi({ ...PUBLIC, 'POST /api/public/unsubscribe': { status: 200, body: { status: 'unsubscribed', key: KEY } } });
    renderApp(`/unsubscribe?t=${'3'.repeat(32)}`, 'zh-TW');
    expect(calls.some((c) => c.url === '/api/public/unsubscribe')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '確認退訂' }));
    expect(await screen.findByTestId('unsub-done')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /重新訂閱/ })).toHaveAttribute('href', `/subscription?k=${KEY}`);
  });

  it.each([
    ['/about/', 'terms', '服務條款'],
    ['/about/privacy', 'privacy', '隱私政策'],
    ['/about/risk', 'risk', '風險揭露'],
  ])('%s 是%s', async (path, page, title) => {
    stubApi(PUBLIC);
    renderApp(path, 'zh-TW');
    expect(screen.getByTestId(`legal-${page}`)).toHaveTextContent(title);
    expect(screen.getByTestId(`legal-${page}`)).toHaveTextContent('Quick Come');
  });
});

const OPS = '/qc-ops-test-0001';

/** 名单页在密钥 ADMIN_PATH 的地址下；页面从当前地址算出接口前缀 */
function renderAdmin() {
  at(OPS);
  return render(<AdminApp />);
}

const ADMIN_BASE = {
  [`${OPS}/api/session`]: { status: 200, body: { ok: true, environment: 'production' } },
  [`${OPS}/api/metrics`]: { status: 200, body: { confirmed: 0, pending: 0, unsubscribed: 0, beta: 0, todayNew: 0, avg7: 0, channels: [], inviters: [] } },
  [`${OPS}/api/subscribers`]: { status: 200, body: { total: 0, next: null, items: [] } },
  [`${OPS}/api/matches`]: { status: 200, body: { items: [], max: 5 } },
};

describe('名单页', () => {
  it('没登录显示密码框；密码错显示通用提示（不说规则）；登录后看到指标、来源名字、邀请排行、名单（邀请人）、焦点战、导出', async () => {
    let logged = false;
    const calls = stubApi({
      [`${OPS}/api/session`]: () => (logged ? { status: 200, body: { ok: true, environment: 'staging' } } : { status: 401, body: { code: 'UNAUTHORIZED' } }),
      [`POST ${OPS}/api/login`]: (_u, init) => {
        const ok = JSON.parse(String(init!.body)).password === 'right-password-123';
        logged = ok;
        return ok ? { status: 204 } : { status: 401, body: { code: 'AUTH_FAILED' } };
      },
      [`${OPS}/api/metrics`]: {
        status: 200,
        body: {
          confirmed: 37,
          pending: 2,
          unsubscribed: 1,
          beta: 3,
          todayNew: 4,
          avg7: 3.1,
          channels: [
            { channel: 'invite', visits: 0, confirmed: 2, beta: 0, rate: null },
            { channel: 'x', visits: 10, confirmed: 3, beta: 1, rate: '30.0%' },
            { channel: '', visits: 5, confirmed: 1, beta: 0, rate: '20.0%' },
          ],
          inviters: [{ email: 'o***@example.com', count: 2 }],
        },
      },
      [`${OPS}/api/subscribers`]: {
        status: 200,
        body: {
          total: 1,
          next: null,
          items: [{ id: 9, email: 'f***@example.com', lang: 'zh-TW', status: 'confirmed', beta: false, channel: 'invite', inviter: 'o***@example.com', invites: 0, createdAt: '2026-10-29T04:00:00.000Z', confirmedAt: null }],
        },
      },
      [`${OPS}/api/matches`]: { status: 200, body: { items: [], max: 5 } },
    });
    const { container } = renderAdmin();
    fireEvent.change(await screen.findByLabelText('密码'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('登录失败，请稍后再试。')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/15 分钟|5 次|锁定|锁/);
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'right-password-123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByTestId('kpi-confirmed')).toHaveTextContent('37');
    expect(screen.getByTestId('env-banner')).toHaveTextContent('测试环境');
    const ch = screen.getByTestId('channels');
    expect(ch).toHaveTextContent('订阅者邀请');
    expect(ch).toHaveTextContent('X');
    expect(ch).toHaveTextContent('直接打开');
    expect(ch).toHaveTextContent('—');
    expect(screen.getByTestId('inviter-rows')).toHaveTextContent('o***@example.com2');
    const rows = await screen.findByTestId('sub-rows');
    expect(rows).toHaveTextContent('订阅者邀请');
    expect(rows).toHaveTextContent('o***@example.com');
    expect(rows).toHaveTextContent('繁中');
    // 页面上没有内部编号和英文技术词
    expect(container.textContent).not.toMatch(/\bM-\d|\bC-\d|JSON|\binvite\b|\bref\b|\bsrc\b|\bcmp\b|ADMIN_PASSWORD|zh-TW|staging/);
    // 密码不留在页面上
    expect((screen.getByTestId('export-pw') as HTMLInputElement).value).toBe('');
    expect(calls.filter((c) => c.url === `${OPS}/api/login`)).toHaveLength(2);
  });

  it('愿意内测 0 人：卡片和筛选都写明原因', async () => {
    stubApi({ ...ADMIN_BASE, [`${OPS}/api/subscribers`]: (u) => ({ status: 200, body: { total: u.includes('beta=1') ? 0 : 3, next: null, items: [] } }) });
    renderAdmin();
    expect(await screen.findByTestId('kpi-beta-note')).toHaveTextContent('还没有人勾选「我愿意参加内测」（留邮箱时选填）');
    fireEvent.click(await screen.findByTestId('filter-beta'));
    await waitFor(() => expect(screen.getByTestId('list-empty')).toHaveTextContent('还没有人勾选「我愿意参加内测」'));
  });

  it('焦点战：联赛是下拉（含"其他"另填）、时间是日期时间选择器、主客队分开；保存前一次标出全部错误，不发请求；填对后按台湾时间送出', async () => {
    const calls = stubApi({ ...ADMIN_BASE, [`POST ${OPS}/api/matches`]: { status: 201, body: {} } });
    renderAdmin();
    const league = (await screen.findByTestId('m-league')) as unknown as HTMLSelectElement;
    expect([...league.options].map((o) => o.textContent)).toEqual(['请选择', 'NBA', 'MLB', '英超', '西甲', '歐冠', '中職', '其他']);
    expect(screen.getByTestId('m-startsAt')).toHaveAttribute('type', 'datetime-local');
    fireEvent.click(screen.getByTestId('m-save'));
    expect(await screen.findByText('有 4 处要改，见标红的字段。')).toBeInTheDocument();
    expect(screen.getAllByText('必填')).toHaveLength(4);
    expect(calls.some((c) => c.method === 'POST' && c.url === `${OPS}/api/matches`)).toBe(false);
    fireEvent.change(league, { target: { value: '其他' } });
    fireEvent.change(screen.getByTestId('m-league-other'), { target: { value: '日職' } });
    fireEvent.change(screen.getByTestId('m-home'), { target: { value: '阪神' } });
    fireEvent.change(screen.getByTestId('m-away'), { target: { value: '巨人' } });
    fireEvent.change(screen.getByTestId('m-startsAt'), { target: { value: '2026-11-02T18:00' } });
    fireEvent.click(screen.getByTestId('m-save'));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === `${OPS}/api/matches`)?.body).toEqual({ league: '日職', home: '阪神', away: '巨人', startsAt: '2026-11-02T18:00', note: '' }));
  });

  it('批量导入：选 CSV → 预览逐行报错，有错不能导入；改好后预览"导入后首页显示"，确认后送出', async () => {
    const calls = stubApi({ ...ADMIN_BASE, [`POST ${OPS}/api/matches/import`]: { status: 200, body: { imported: 2, skipped: 0, removed: 0, total: 2, max: 5 } } });
    renderAdmin();
    const input = (await screen.findByTestId('imp-file')) as HTMLInputElement;
    const csv = (text: string) => new File([`﻿${text}`], 'matches.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [csv('聯賽,主隊,客隊,開賽時間（台灣）,備註\nNBA,湖人,勇士,2030-11-02 10:30,\n,甲,,2030-02-30 10:00,\n')] } });
    expect(await screen.findByTestId('imp-preview')).toHaveTextContent('预览：共 2 行');
    expect(screen.getByTestId('imp-rows')).toHaveTextContent('第 3 行 联赛：必填');
    expect(screen.getByTestId('imp-rows')).toHaveTextContent('第 3 行 客队：必填');
    expect(screen.getByTestId('imp-rows')).toHaveTextContent('第 3 行 开赛时间（台湾）：没有这个日期或时间');
    expect(screen.getByTestId('imp-errors')).toHaveTextContent('有 1 行要改');
    expect(screen.getByTestId('imp-confirm')).toBeDisabled();
    fireEvent.change(input, { target: { files: [csv('聯賽,主隊,客隊,開賽時間（台灣）,備註\nNBA,湖人,勇士,2030-11-02 10:30,\n英超,兵工廠,利物浦,2030/11/3 0:30,週日\n')] } });
    await waitFor(() => expect(screen.getByTestId('imp-rows')).toHaveTextContent('2030-11-03 00:30'));
    expect(screen.getAllByText('导入后首页显示')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('imp-confirm'));
    await waitFor(() => expect(calls.find((c) => c.url === `${OPS}/api/matches/import`)?.body).toEqual({
      items: [
        { league: 'NBA', home: '湖人', away: '勇士', startsAt: '2030-11-02 10:30', note: '' },
        { league: '英超', home: '兵工廠', away: '利物浦', startsAt: '2030/11/3 0:30', note: '週日' },
      ],
      replace: false,
    }));
    expect(await screen.findByText('已导入 2 场，首页已更新。')).toBeInTheDocument();
  });

  it('表头不对：说明缺哪几列', async () => {
    stubApi(ADMIN_BASE);
    renderAdmin();
    const input = (await screen.findByTestId('imp-file')) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['league,home\nNBA,湖人\n'], 'x.csv')] } });
    expect(await screen.findByText(/缺少：聯賽、主隊、客隊、開賽時間（台灣）/)).toBeInTheDocument();
  });
});
