/** 每个页面共用的框架：测试环境标识条、顶部（Logo、社媒、语言）、页脚（风险提示、法律页、社媒、M-12 备用网址）。 */
import type { ReactNode } from 'react';
import { LANGS, type Lang } from '../../../shared/rules';
import { SOCIAL } from '../content/social';
import { LANG_LABEL, useI18n } from '../i18n';
import { useSiteInfo, type SiteInfo } from '../lib/site';

export function Logo({ suffix }: { suffix?: string }) {
  return (
    <a className="logo" href="/">
      <i aria-hidden="true">
        <b />
        <b />
      </i>
      Quick Come{suffix ? ` · ${suffix}` : ''}
    </a>
  );
}

export function EnvBanner({ info }: { info: SiteInfo | null }) {
  const { t } = useI18n();
  if (!info || info.environment === 'production') return null;
  return (
    <div className="envbar" role="note" data-testid="env-banner">
      {t('env.banner')}
    </div>
  );
}

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <label className="pill lang">
      <span className="sr">{t('nav.lang')}</span>
      <select aria-label={t('nav.lang')} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {LANG_LABEL[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TopBar({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="bar">
      <Logo />
      <div className="social">
        {!compact && (
          <>
            <a className="pill x" href={SOCIAL.x.url} target="_blank" rel="noopener noreferrer">
              {t('nav.followX')}
            </a>
            <a className="pill" href={SOCIAL.threads.url} target="_blank" rel="noopener noreferrer">
              {t('nav.followThreads')}
            </a>
          </>
        )}
        <LangSwitch />
      </div>
    </div>
  );
}

export function Footer({ info }: { info: SiteInfo | null }) {
  const { t } = useI18n();
  return (
    <footer>
      <div className="wrap">
        <p className="risk">{t('footer.risk')}</p>
        <div className="cols">
          <span>
            <a href="/about/terms">{t('footer.terms')}</a> · <a href="/about/privacy">{t('footer.privacy')}</a> · <a href="/about/risk">{t('footer.riskLink')}</a>
          </span>
          <span>
            {t('footer.x')}{' '}
            <a href={SOCIAL.x.url} target="_blank" rel="noopener noreferrer">
              {SOCIAL.x.handle}
            </a>{' '}
            · {t('footer.threads')}{' '}
            <a href={SOCIAL.threads.url} target="_blank" rel="noopener noreferrer">
              {SOCIAL.threads.handle}
            </a>
          </span>
          {info?.backupUrl && (
            <span data-testid="backup-url">
              {t('footer.backup')} <a className="mono" href={info.backupUrl}>{info.backupUrl.replace(/^https:\/\//, '')}</a>
            </span>
          )}
        </div>
      </div>
    </footer>
  );
}

/** 首页以外的页面：深蓝顶部（只有 Logo 和语言）+ 内容 + 页脚 */
export function SimplePage({ children }: { children: ReactNode }) {
  const info = useSiteInfo();
  return (
    <>
      <EnvBanner info={info} />
      <div className="top">
        <div className="wrap">
          <TopBar compact />
        </div>
      </div>
      <main className="wrap page">{children}</main>
      <Footer info={info} />
    </>
  );
}
