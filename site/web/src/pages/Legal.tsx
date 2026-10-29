/** /about/terms、/about/privacy、/about/risk（/about/ 给服务条款）。正文在 content/legal.ts。 */
import { SimplePage } from '../components/Chrome';
import { LEGAL, LEGAL_UPDATED, type LegalPage } from '../content/legal';
import { useI18n } from '../i18n';

export function Legal({ page }: { page: LegalPage }) {
  const { t, lang } = useI18n();
  const doc = LEGAL[page][lang];
  return (
    <SimplePage>
      <article className="legal" data-testid={`legal-${page}`}>
        <nav className="legal-nav">
          <a href="/">{t('legal.back')}</a> · <a href="/about/terms">{t('footer.terms')}</a> · <a href="/about/privacy">{t('footer.privacy')}</a> ·{' '}
          <a href="/about/risk">{t('footer.riskLink')}</a>
        </nav>
        <h1>{doc.title}</h1>
        <p className="muted small">
          {t('legal.updated', { date: LEGAL_UPDATED })} · {t('legal.draft')}
        </p>
        {doc.intro.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        {doc.sections.map((s) => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </section>
        ))}
      </article>
    </SimplePage>
  );
}
