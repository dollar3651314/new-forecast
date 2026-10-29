/**
 * 首页（等候页）：按原型（qc-prototype，Amos 2026-10-29 确认）——深蓝顶部（卖点 + 留邮箱），浅色内容区（焦点战、怎么玩、充值、常见问题）。
 * 手机和电脑分开排版（C64）：电脑首屏左边卖点、右边留邮箱；手机卖点（标题、返奖率对照）在上，留邮箱紧接着，口径说明放到表单下面，
 * 保证 390×844 不滚动就能看到"上线时通知我"按钮（C79）。
 */
import { useEffect, useMemo } from 'react';
import { Footer, EnvBanner, TopBar } from '../components/Chrome';
import { Deposit, Faq, HowTo, Matches, ReturnRate } from '../components/Sections';
import { SubscribeForm, useSubscribeState } from '../components/SubscribeForm';
import { useI18n } from '../i18n';
import { currentAttribution, reportVisit } from '../lib/attribution';
import { useIsDesktop, useSiteInfo } from '../lib/site';

export function Home() {
  const { t } = useI18n();
  const info = useSiteInfo();
  const desktop = useIsDesktop();
  const attribution = useMemo(() => currentAttribution(location.search), []);
  useEffect(() => reportVisit(attribution), [attribution]);
  const form = useSubscribeState();
  const pitch = (
    <>
      <div className="eyebrow">{t('hero.eyebrow')}</div>
      <h1>
        {t('hero.title1')}
        <br />
        {t('hero.title2')}
      </h1>
      <p className="sub">{t('hero.sub')}</p>
    </>
  );
  return (
    <>
      <EnvBanner info={info} />
      <div className="top">
        <div className="wrap">
          <TopBar />
          {desktop ? (
            <div className="hero" data-layout="desktop">
              <div>
                {pitch}
                <ReturnRate />
              </div>
              <SubscribeForm attribution={attribution} state={form} />
            </div>
          ) : (
            <div className="hero mobile" data-layout="mobile">
              <div className="eyebrow">{t('hero.eyebrow')}</div>
              <h1>
                {t('hero.title1')}
                <br />
                {t('hero.title2')}
              </h1>
              <ReturnRateBars />
              <SubscribeForm attribution={attribution} state={form} />
              <p className="sub">{t('hero.sub')}</p>
              <p className="foot">{t('hero.foot')}</p>
            </div>
          )}
        </div>
      </div>
      <main className="wrap">
        <Matches />
        <HowTo />
        <Deposit />
        <Faq />
      </main>
      <Footer info={info} />
    </>
  );
}

/** 手机版首屏只放对照条，口径说明放到表单下面 */
function ReturnRateBars() {
  return (
    <div className="bars-only">
      <ReturnRate />
    </div>
  );
}
