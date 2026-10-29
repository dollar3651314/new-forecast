/**
 * 订阅者的专属页面 /subscription?k=<私密密钥>（v1.1：合并了原来的确认页和邀请查看页，Amos 验收"不要跳来跳去"）。
 * 确认邮件里只有这一个链接。任何时候打开、刷新都是同一个页面：
 * - 页面打开后**由脚本自动**调用 POST /api/public/subscription（不用按按钮）：待确认的在这一步确认；
 *   邮件安全扫描器预先打开链接时一般不执行脚本，不会替人确认（GET 页面本身没有任何副作用）。
 * - 已确认：订阅成功（勾了内测多一句）、充值提醒、专属邀请链接（一键复制）、你已邀请 N 人；最下面可以取消订阅。
 * - 已退订：显示已退订和"重新订阅"。
 * - 链接过期（410）：说明并给"重新寄送确认信"；链接无效（404）：说明并给"回首页重新留信箱"；暂时出错：原因 + 重试（C56）。
 */
import { useCallback, useEffect, useState } from 'react';
import { SimplePage } from '../components/Chrome';
import { InvitePanel, type InviteInfo } from '../components/InvitePanel';
import { useI18n } from '../i18n';
import { api, errorText, type ApiError } from '../lib/api';

interface SubState {
  status: 'confirmed' | 'unsubscribed' | 'pending';
  beta: boolean;
  invite?: InviteInfo;
}

type View =
  | { kind: 'loading' }
  | { kind: 'ok'; data: SubState }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'error'; error: ApiError };

export function Subscription() {
  const { t } = useI18n();
  const key = new URLSearchParams(location.search).get('k') ?? '';
  const [view, setView] = useState<View>(key ? { kind: 'loading' } : { kind: 'invalid' });
  const [busy, setBusy] = useState(false);
  const [askUnsub, setAskUnsub] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const call = useCallback(
    async (path: string) => {
      const r = await api<SubState & { sent?: boolean }>(path, { body: { key } });
      if (r.ok) {
        setView({ kind: 'ok', data: r.data });
        return r;
      }
      if (r.error.kind === 'notFound') setView({ kind: 'invalid' });
      else if (r.error.kind === 'expired') setView({ kind: 'expired' });
      return r;
    },
    [key],
  );

  const open = useCallback(() => {
    if (!key) return;
    setView({ kind: 'loading' });
    void call('/api/public/subscription').then((r) => {
      if (!r.ok && r.error.kind !== 'notFound' && r.error.kind !== 'expired') setView({ kind: 'error', error: r.error });
    });
  }, [key, call]);
  useEffect(open, [open]);

  async function act(path: string) {
    setBusy(true);
    setMsg(null);
    const r = await call(path);
    setBusy(false);
    setAskUnsub(false);
    if (!r.ok && r.error.kind !== 'notFound' && r.error.kind !== 'expired') setMsg({ ok: false, text: t(...errorText(r.error)) });
  }

  async function resend() {
    setBusy(true);
    setMsg(null);
    const r = await api<SubState & { sent?: boolean }>('/api/public/subscription/resend', { body: { key } });
    setBusy(false);
    if (r.ok) {
      if (r.data.status === 'pending') setMsg({ ok: true, text: t('sub.resent') });
      else setView({ kind: 'ok', data: r.data });
      return;
    }
    if (r.error.kind === 'notFound') return setView({ kind: 'invalid' });
    if (r.error.kind === 'rateLimited') return setMsg({ ok: false, text: t('sub.resendTooSoon', { minutes: Math.max(1, Math.ceil(r.error.seconds / 60)) }) });
    setMsg({ ok: false, text: t(...errorText(r.error)) });
  }

  const message = msg && (
    <p className={msg.ok ? 'ok-msg' : 'form-err light'} role={msg.ok ? 'status' : 'alert'} data-testid="sub-msg">
      {msg.text}
    </p>
  );

  return (
    <SimplePage>
      <h2 className="page-h">{t('sub.pageTitle')}</h2>
      {view.kind === 'loading' && (
        <div className="panel" data-testid="sub-loading">
          <p className="lead flat">{t('sub.opening')}</p>
        </div>
      )}
      {view.kind === 'error' && (
        <div className="panel" data-testid="sub-error">
          <p className="form-err light" role="alert">
            {t(...errorText(view.error))}{' '}
            <button type="button" className="linkbtn" onClick={open}>
              {t('common.retry')}
            </button>
          </p>
        </div>
      )}
      {view.kind === 'invalid' && (
        <div className="panel" data-testid="sub-invalid">
          <h3>{t('sub.invalidTitle')}</h3>
          <p className="lead">{t('sub.invalidBody')}</p>
          <a className="btn" href="/" style={{ textAlign: 'center', textDecoration: 'none' }}>
            {t('sub.backToForm')}
          </a>
        </div>
      )}
      {view.kind === 'expired' && (
        <div className="panel" data-testid="sub-expired">
          <h3>{t('sub.expiredTitle')}</h3>
          <p className="lead">{t('sub.expiredBody')}</p>
          <button type="button" className="btn" onClick={() => void resend()} disabled={busy} data-testid="sub-resend">
            {busy ? t('sub.working') : t('sub.resend')}
          </button>
          {message}
        </div>
      )}
      {view.kind === 'ok' && view.data.status === 'unsubscribed' && (
        <div className="panel" data-testid="sub-unsubscribed">
          <h3>{t('sub.unsubbedTitle')}</h3>
          <p className="lead">{t('sub.unsubbedBody')}</p>
          <button type="button" className="btn" onClick={() => void act('/api/public/subscription/resubscribe')} disabled={busy} data-testid="sub-resubscribe">
            {busy ? t('sub.working') : t('sub.resubscribe')}
          </button>
          {message}
        </div>
      )}
      {view.kind === 'ok' && view.data.status === 'confirmed' && (
        <>
          <div className="panel" data-testid="sub-ok">
            <div className="ok" aria-hidden="true">
              ✓
            </div>
            <h3>{t('sub.okTitle')}</h3>
            <p className="lead flat">
              {t('sub.okBody')}
              {view.data.beta ? ` ${t('sub.okBeta')}` : ''}
            </p>
          </div>
          <div className="panel" data-testid="deposit-tip">
            <h3 className="h-sm">{t('sub.depTitle')}</h3>
            <p className="lead flat">{t('dep.short')}</p>
          </div>
          {view.data.invite && <InvitePanel invite={view.data.invite} />}
          <p className="small muted">{t('sub.revisit')}</p>
          <div className="unsub-row">
            {!askUnsub ? (
              <button type="button" className="linkbtn quiet" onClick={() => setAskUnsub(true)} data-testid="sub-unsub-open">
                {t('sub.unsubOpen')}
              </button>
            ) : (
              <div className="panel">
                <p className="lead">{t('sub.unsubAsk')}</p>
                <div className="btns">
                  <button type="button" className="btn ghost-light" onClick={() => void act('/api/public/subscription/unsubscribe')} disabled={busy} data-testid="sub-unsub-yes">
                    {busy ? t('sub.working') : t('sub.unsubYes')}
                  </button>
                  <button type="button" className="btn" onClick={() => setAskUnsub(false)} disabled={busy}>
                    {t('sub.unsubNo')}
                  </button>
                </div>
              </div>
            )}
            {message}
          </div>
        </>
      )}
      {view.kind === 'ok' && view.data.status === 'pending' && (
        // 理论上不会出现（打开时已确认）；保险起见给重试
        <div className="panel" data-testid="sub-pending">
          <p className="lead">{t('sub.opening')}</p>
          <button type="button" className="btn" onClick={open}>
            {t('common.retry')}
          </button>
        </div>
      )}
    </SimplePage>
  );
}
