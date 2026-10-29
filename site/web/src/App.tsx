/**
 * 公开页面的路由（按地址显示对应页面；页面之间用普通链接跳转）：
 * /  首页 · /confirm 确认订阅 · /unsubscribe 退订 · /invite 邀请查看 · /about/、/about/terms、/about/privacy、/about/risk 法律页。
 * 名单页 /admin 是单独的入口（admin.html），不在这里，公开页面的代码里没有名单页的接口。
 */
import { useEffect } from 'react';
import { useI18n } from './i18n';
import { Confirm } from './pages/Confirm';
import { Home } from './pages/Home';
import { InvitePage } from './pages/InvitePage';
import { Legal } from './pages/Legal';
import { NotFound } from './pages/NotFound';
import { Unsubscribe } from './pages/Unsubscribe';

export function route(pathname: string): string {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  if (p === '/confirm') return 'confirm';
  if (p === '/unsubscribe') return 'unsubscribe';
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
    case 'invite':
      return <InvitePage />;
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
