/** 退订 /unsubscribe?t=<退订码>（邮件头 List-Unsubscribe 的地址）：不用登录；按"确认退订"才退订（打开页面不会自动退订）。退订后给专属页面的入口，可以重新订阅。 */
import { useState } from 'react';
import { SimplePage } from '../components/Chrome';
import { useI18n } from '../i18n';
import { api, errorText } from '../lib/api';

export function Unsubscribe() {
  const { t } = useI18n();
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ key?: string } | null>(null);
  const [err, setErr] = useState<{ text: string; final: boolean } | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    const r = await api<{ key?: string }>('/api/public/unsubscribe', { body: { token } });
    setBusy(false);
    if (r.ok) return setDone({ key: r.data?.key });
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
          <>
            <p className="lead flat" data-testid="unsub-done">
              {t('unsub.done')}
            </p>
            {done.key && (
              <p>
                <a href={`/subscription?k=${encodeURIComponent(done.key)}`}>{t('unsub.again')}</a>
              </p>
            )}
          </>
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
