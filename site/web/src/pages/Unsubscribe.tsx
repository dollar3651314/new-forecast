/** 退订 /unsubscribe?t=<退订码>：不用登录；按"确认退订"才退订（打开页面不会自动退订）。 */
import { useState } from 'react';
import { SimplePage } from '../components/Chrome';
import { useI18n } from '../i18n';
import { api, errorText } from '../lib/api';

export function Unsubscribe() {
  const { t } = useI18n();
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<{ text: string; final: boolean } | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    const r = await api('/api/public/unsubscribe', { body: { token } });
    setBusy(false);
    if (r.ok) return setDone(true);
    if (r.error.kind === 'notFound') return setErr({ text: t('unsub.invalid'), final: true });
    const [k, v] = errorText(r.error);
    setErr({ text: t(k, v), final: false });
  }

  return (
    <SimplePage>
      <div className="panel" data-testid="unsub">
        <h3>{t('unsub.title')}</h3>
        {!token ? (
          <p className="lead flat">{t('unsub.missing')}</p>
        ) : done ? (
          <p className="lead flat" data-testid="unsub-done">
            {t('unsub.done')}
          </p>
        ) : (
          <>
            <p className="lead">{t('unsub.lead')}</p>
            {!(err && err.final) && (
              <button className="btn" type="button" onClick={go} disabled={busy}>
                {busy ? t('unsub.working') : t('unsub.button')}
              </button>
            )}
          </>
        )}
        {err && (
          <p className="form-err light" role="alert">
            {err.text}
          </p>
        )}
        <p>
          <a href="/">{t('common.home')}</a>
        </p>
      </div>
    </SimplePage>
  );
}
