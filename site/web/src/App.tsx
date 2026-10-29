/**
 * 公开页面的路由（按地址显示对应页面；页面之间用普通链接跳转）：
 * /  首页 · /subscription 订阅者的专属页面（确认 + 邀请 + 退订）· /unsubscribe 退订 · /about/、/about/terms、/about/privacy、/about/risk 法律页。
 * 旧地址兼容：/confirm?t=（v1 的确认链接）换到密钥后跳到专属页面；/invite?k=（v1 的邀请查看页）直接跳到 /subscription?k=。
 * 名单页 /admin 是单独的入口（admin.html），不在这里，公开页面的代码里没有名单页的接口。
 */
import { useEffect } from 'react';
import { useI18n } from './i18n';
import { Confirm } from './pages/Confirm';
import { Home } from './pages/Home';
import { Legal } from './pages/Legal';
import { NotFound } from './pages/NotFound';
import { Subscription } from './pages/Subscription';
import { Unsubscribe } from './pages/Unsubscribe';

export function route(pathname: string): string {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  if (p === '/confirm') return 'confirm';
  if (p === '/unsubscribe') return 'unsubscribe';
  if (p === '/subscription') return 'subscription';
  if (p === '/invite') return 'invite';
  if (p === '/about' || p === '/about/terms') return 'terms';
  if (p === '/about/privacy') return 'privacy';
  if (p === '/about/risk') return 'risk';
  return 'notfound';
}

export function App({ pathname = location.pathname }: { pathname?: string }) {
  const { t } = useI18n();
  useEffect(() => {
    document.title = t('meta.title');
  }, [t]);
  switch (route(pathname)) {
    case 'home':
      return <Home />;
    case 'confirm':
      return <Confirm />;
    case 'unsubscribe':
      return <Unsubscribe />;
    case 'subscription':
      return <Subscription />;
    case 'invite':
      return <LegacyInvite />;
    case 'terms':
      return <Legal page="terms" />;
    case 'privacy':
      return <Legal page="privacy" />;
    case 'risk':
      return <Legal page="risk" />;
    default:
      return <NotFound />;
  }
}

/** 旧的邀请查看页 /invite?k=…：密钥就是专属页面的密钥，直接换地址 */
function LegacyInvite() {
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    location.replace(`/subscription?k=${encodeURIComponent(q.get('k') ?? '')}`);
  }, []);
  return null;
}
