/** 邀请查看页 /invite?k=<私密密钥>（M-10）：不需要登录，只给订阅者本人（链接在确认邮件和确认页里）。 */
import { useCallback, useEffect, useState } from 'react';
import { SimplePage } from '../components/Chrome';
import { InvitePanel, type InviteInfo } from '../components/InvitePanel';
import { useI18n } from '../i18n';
import { api, errorText, type ApiError } from '../lib/api';

export function InvitePage() {
  const { t } = useI18n();
  const key = new URLSearchParams(location.search).get('k') ?? '';
  const [s, setS] = useState<{ state: 'loading' } | { state: 'ok'; status: string; invite?: InviteInfo } | { state: 'error'; error: ApiError }>({ state: 'loading' });
  const load = useCallback(() => {
    if (!key) return setS({ state: 'error', error: { kind: 'notFound' } });
    setS({ state: 'loading' });
    void api<{ status: string; invite?: InviteInfo }>(`/api/public/invite?k=${encodeURIComponent(key)}`).then((r) =>
      setS(r.ok ? { state: 'ok', status: r.data.status, invite: r.data.invite } : { state: 'error', error: r.error }),
    );
  }, [key]);
  useEffect(load, [load]);
  return (
    <SimplePage>
      <h2 className="page-h">{t('invite.pageTitle')}</h2>
      {s.state === 'loading' && <p>{t('common.loading')}</p>}
      {s.state === 'error' &&
        (s.error.kind === 'notFound' ? (
          <div className="panel">
            <p className="lead flat">{t('invite.invalid')}</p>
          </div>
        ) : (
          <div className="panel">
            <p className="form-err light" role="alert">
              {t(...errorText(s.error))}{' '}
              <button type="button" className="linkbtn" onClick={load}>
                {t('common.retry')}
              </button>
            </p>
          </div>
        ))}
      {s.state === 'ok' && !s.invite && (
        <div className="panel" data-testid="invite-pending">
          <p className="lead flat">{t('invite.pending')}</p>
        </div>
      )}
      {s.state === 'ok' && s.invite && (
        <>
          {s.status === 'unsubscribed' && <p className="muted">{t('invite.unsubscribed')}</p>}
          <InvitePanel invite={s.invite} />
        </>
      )}
    </SimplePage>
  );
}
