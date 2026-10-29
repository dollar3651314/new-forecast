/** 页面组件：首页（电脑两栏 / 手机单栏）、留邮箱表单、确认页（按按钮才确认）、语言切换、焦点战空状态和出错、名单页登录和焦点战校验。 */
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
  '/api/public/matches': { status: 200, body: { items: [{ id: 1, league: 'NBA', title: '湖人 vs 勇士', startsAt: '2026-11-02T02:30:00.000Z', note: '' }] } },
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
  it('送出前就用同一套规则标出错误；正确时带上语言、内测、来源、陷阱字段送出，显示"请到信箱收确认信"', async () => {
    const calls = stubApi({ ...PUBLIC, 'POST /api/public/subscribe': { status: 200, body: { status: 'check_email' } } });
    renderApp('/?ref=K7Q2XA', 'zh-TW');
    fireEvent.click(screen.getByRole('button', { name: '上線時通知我' }));
    expect(await screen.findByText('請填寫電子信箱。')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('電子信箱'), { target: { value: 'a@b' } });
    fireEvent.click(screen.getByRole('button', { name: '上線時通知我' }));
    expect(await screen.findByText(/電子信箱格式不對/)).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/public/subscribe')).toBe(false);
    fireEvent.change(screen.getByLabelText('電子信箱'), { target: { value: ' you@example.com ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /我願意參加內測/ }));
    fireEvent.click(screen.getByRole('button', { name: '上線時通知我' }));
    expect(await screen.findByTestId('subscribe-done')).toHaveTextContent('you@example.com');
    expect(calls.find((c) => c.url === '/api/public/subscribe')!.body).toEqual({ email: 'you@example.com', lang: 'zh-TW', beta: true, website: '', src: null, cmp: null, ref: 'K7Q2XA' });
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

describe('确认页', () => {
  it('打开页面不调用确认接口；按"确认订阅"后显示成功、充值提醒（BEP20）和邀请链接', async () => {
    const calls = stubApi({
      ...PUBLIC,
      'POST /api/public/confirm': {
        status: 200,
        body: { status: 'confirmed', lang: 'zh-TW', beta: true, invite: { code: 'K7Q2XA', key: 'a'.repeat(32), link: 'https://www.quickcome.online/?ref=K7Q2XA', count: 2 } },
      },
    });
    renderApp(`/confirm?t=${'1'.repeat(32)}`, 'zh-TW');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(calls.some((c) => c.url === '/api/public/confirm')).toBe(false);
    fireEvent.click(screen.getByTestId('confirm-btn'));
    expect(await screen.findByTestId('confirm-ok')).toHaveTextContent('訂閱成功');
    expect(screen.getByTestId('confirm-ok')).toHaveTextContent('願意參加內測');
    expect(screen.getByTestId('deposit-tip')).toHaveTextContent('BEP20');
    expect(screen.getByTestId('invite-link')).toHaveTextContent('https://www.quickcome.online/?ref=K7Q2XA');
    expect(screen.getByTestId('invite-count')).toHaveTextContent('你已邀請 2 人');
    expect(screen.getByRole('link', { name: '打開我的專屬頁面' })).toHaveAttribute('href', `/invite?k=${'a'.repeat(32)}`);
    expect(calls.find((c) => c.url === '/api/public/confirm')!.body).toEqual({ token: '1'.repeat(32) });
  });

  it('链接无效（404）、过期（410）、暂时出错（可重试）分开显示', async () => {
    let r: { status: number; body?: unknown } = { status: 404, body: { code: 'LINK_INVALID' } };
    stubApi({ ...PUBLIC, 'POST /api/public/confirm': () => r });
    renderApp(`/confirm?t=${'1'.repeat(32)}`, 'zh-TW');
    fireEvent.click(screen.getByTestId('confirm-btn'));
    expect(await screen.findByText(/這個確認連結無效/)).toBeInTheDocument();
    expect(screen.queryByTestId('confirm-btn')).toBeNull();
    r = { status: 410, body: { code: 'LINK_EXPIRED' } };
    renderApp(`/confirm?t=${'2'.repeat(32)}`, 'zh-TW');
    fireEvent.click(screen.getAllByTestId('confirm-btn')[0]);
    expect(await screen.findByText(/已經超過 7 天/)).toBeInTheDocument();
  });

  it('暂时出错：按钮还在，可以重试', async () => {
    stubApi({ ...PUBLIC, 'POST /api/public/confirm': { status: 500 } });
    renderApp(`/confirm?t=${'1'.repeat(32)}`, 'zh-TW');
    fireEvent.click(screen.getByTestId('confirm-btn'));
    expect(await screen.findByText(/伺服器暫時出錯/)).toBeInTheDocument();
    expect(screen.getByTestId('confirm-btn')).toBeInTheDocument();
  });
});

describe('邀请查看页、退订页、法律页', () => {
  it('邀请查看页：确认过的显示链接和人数；没确认的提示先确认', async () => {
    stubApi({ ...PUBLIC, '/api/public/invite': (u) => (u.includes('k=a') ? { status: 200, body: { status: 'confirmed', invite: { code: 'K7Q2XA', key: 'a', link: 'https://x/?ref=K7Q2XA', count: 0 } } } : { status: 200, body: { status: 'pending' } }) });
    renderApp('/invite?k=a', 'zh-TW');
    expect(await screen.findByTestId('invite-count')).toHaveTextContent('你已邀請 0 人');
    renderApp('/invite?k=b', 'zh-TW');
    expect(await screen.findByTestId('invite-pending')).toBeInTheDocument();
  });

  it('退订页：按按钮才退订', async () => {
    const calls = stubApi({ ...PUBLIC, 'POST /api/public/unsubscribe': { status: 200, body: { status: 'unsubscribed' } } });
    renderApp(`/unsubscribe?t=${'3'.repeat(32)}`, 'zh-TW');
    expect(calls.some((c) => c.url === '/api/public/unsubscribe')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '確認退訂' }));
    expect(await screen.findByTestId('unsub-done')).toBeInTheDocument();
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

describe('名单页', () => {
  it('没登录显示密码框；密码错显示原因；登录后看到指标、名单、焦点战、导出', async () => {
    let logged = false;
    const calls = stubApi({
      '/api/admin/session': () => (logged ? { status: 200, body: { ok: true, environment: 'staging' } } : { status: 401, body: { code: 'UNAUTHORIZED' } }),
      'POST /api/admin/login': (_u, init) => {
        const ok = JSON.parse(String(init!.body)).password === 'right-password-123';
        logged = ok;
        return ok ? { status: 204 } : { status: 401, body: { code: 'WRONG_PASSWORD' } };
      },
      '/api/admin/metrics': { status: 200, body: { confirmed: 37, pending: 2, unsubscribed: 1, beta: 3, todayNew: 4, avg7: 3.1, channels: [{ channel: 'invite', visits: 0, confirmed: 0, beta: 0, rate: null }] } },
      '/api/admin/subscribers': { status: 200, body: { total: 0, next: null, items: [] } },
      '/api/admin/matches': { status: 200, body: { items: [], max: 5 } },
    });
    render(<AdminApp />);
    fireEvent.change(await screen.findByLabelText('密码'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText(/密码不对/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'right-password-123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByTestId('kpi-confirmed')).toHaveTextContent('37');
    expect(screen.getByTestId('env-banner')).toHaveTextContent('测试环境');
    expect(screen.getByTestId('channels')).toHaveTextContent('订阅者邀请（M-10）');
    expect(screen.getByTestId('channels')).toHaveTextContent('—');
    expect(await screen.findByText('还没有订阅')).toBeInTheDocument();
    expect(screen.getByText(/还没有焦点战/)).toBeInTheDocument();
    // 密码不留在页面上
    expect((screen.getByTestId('export-pw') as HTMLInputElement).value).toBe('');
    expect(calls.filter((c) => c.url === '/api/admin/login')).toHaveLength(2);
  });

  it('焦点战：保存前用同一套规则标出每个字段的错误，一次全部提示，不发请求', async () => {
    const calls = stubApi({
      '/api/admin/session': { status: 200, body: { ok: true, environment: 'production' } },
      '/api/admin/metrics': { status: 200, body: { confirmed: 0, pending: 0, unsubscribed: 0, beta: 0, todayNew: 0, avg7: 0, channels: [] } },
      '/api/admin/subscribers': { status: 200, body: { total: 0, next: null, items: [] } },
      '/api/admin/matches': { status: 200, body: { items: [], max: 5 } },
    });
    render(<AdminApp />);
    fireEvent.change(await screen.findByTestId('m-startsAt'), { target: { value: '明天晚上' } });
    fireEvent.click(screen.getByTestId('m-save'));
    expect(await screen.findByText('有 3 处要改，见标红的字段。')).toBeInTheDocument();
    expect(screen.getAllByText('必填')).toHaveLength(2);
    expect(screen.getByText(/时间写成 年-月-日 时:分/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/admin/matches')).toBe(false);
  });
});
