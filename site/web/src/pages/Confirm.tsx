/**
 * 确认订阅 /confirm?t=<确认码>：**打开页面不会自动确认**，要按"确认订阅"按钮（防止邮箱的链接扫描器替人确认）。
 * 成功后显示：订阅成功（勾了内测的多一句）、M-4 充值提醒、M-10 专属邀请链接和人数。
 * 出错分清：链接无效（404）、超过 7 天（410）、暂时连不上（重试）（C56）。
 */
import { useState } from 'react';
import { SimplePage } from '../components/Chrome';
import { InvitePanel, type InviteInfo } from '../components/InvitePanel';
import { useI18n } from '../i18n';
import { api, errorText } from '../lib/api';

interface ConfirmResult {
  status: string;
  beta: boolean;
  invite?: InviteInfo;
}

export function Confirm() {
  const { t } = useI18n();
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ConfirmResult | null>(null);
  const [err, setErr] = useState<{ text: string; final: boolean } | null>(null);

  async function go() {
    setBusy(true);
    setErr(null);
    const r = await api<ConfirmResult>('/api/public/confirm', { body: { token } });
    setBusy(false);
    if (r.ok) return setRes(r.data);
    if (r.error.kind === 'notFound') return setErr({ text: t('confirm.invalid'), final: true });
    if (r.error.kind === 'expired') return setErr({ text: t('confirm.expired'), final: true });
    const [k, v] = errorText(r.error);
    setErr({ text: t(k, v), final: false });
  }

  if (!token) {
    return (
      <SimplePage>
        <div className="panel">
          <h3>{t('confirm.title')}</h3>
          <p className="lead flat">{t('confirm.missing')}</p>
          <p>
            <a href="/">{t('common.home')}</a>
          </p>
        </div>
      </SimplePage>
    );
  }

  if (res && res.status === 'confirmed') {
    return (
      <SimplePage>
        <div className="panel" data-testid="confirm-ok">
          <div className="ok" aria-hidden="true">
            ✓
          </div>
          <h3>{t('confirm.okTitle')}</h3>
          <p className="lead flat">
            {t('confirm.okBody')}
            {res.beta ? ` ${t('confirm.okBeta')}` : ''}
          </p>
        </div>
        <div className="panel" data-testid="deposit-tip">
          <h3 className="h-sm">{t('confirm.depTitle')}</h3>
          <p className="lead flat">{t('dep.short')}</p>
        </div>
        {res.invite && <InvitePanel invite={res.invite} showPrivateLink />}
      </SimplePage>
    );
  }

  return (
    <SimplePage>
      <div className="panel" data-testid="confirm-pending">
        <h3>{t('confirm.title')}</h3>
        {res && res.status === 'unsubscribed' ? (
          <p className="lead flat">{t('unsub.done')}</p>
        ) : (
          <>
            <p className="lead">{t('confirm.lead')}</p>
            {!(err && err.final) && (
              <button className="btn" type="button" onClick={go} disabled={busy} data-testid="confirm-btn">
                {busy ? t('confirm.working') : t('confirm.button')}
              </button>
            )}
          </>
        )}
        {err && (
          <p className="form-err light" role="alert">
            {err.text} {err.final && <a href="/">{t('common.home')}</a>}
          </p>
        )}
      </div>
    </SimplePage>
  );
}
