/**
 * 旧的确认链接 /confirm?t=<确认码>（v1 的确认邮件）：兼容跳转到专属页面 /subscription?k=…（v1.1）。
 * 页面脚本调用 POST /api/public/confirm 换到私密密钥后跳转（和专属页面一样：GET 页面本身不确认，扫描器预先打开不会替人确认）。
 * 出错分清：链接无效（404）、暂时连不上（重试）（C56）；过期（410）也给密钥，跳过去在专属页面上重寄。
 */
import { useCallback, useEffect, useState } from 'react';
import { SimplePage } from '../components/Chrome';
import { useI18n } from '../i18n';
import { errorText, type ApiError } from '../lib/api';

export function Confirm() {
  const { t } = useI18n();
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const [err, setErr] = useState<ApiError | null>(token ? null : { kind: 'notFound' });
  const go = useCallback(() => {
    if (!token) return;
    setErr(null);
    // 直接用 fetch（不用 api.ts）：410 时也要读正文里的密钥
    void fetch('/api/public/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { key?: string };
        if ((res.ok || res.status === 410) && body.key) return location.replace(`/subscription?k=${encodeURIComponent(body.key)}`);
        setErr(res.status === 404 ? { kind: 'notFound' } : { kind: 'server' });
      })
      .catch(() => setErr({ kind: 'network' }));
  }, [token]);
  useEffect(go, [go]);
  return (
    <SimplePage>
      <h2 className="page-h">{t('sub.pageTitle')}</h2>
      {!err && (
        <div className="panel" data-testid="confirm-redirect">
          <p className="lead flat">{t('confirm.working')}</p>
        </div>
      )}
      {err?.kind === 'notFound' && (
        <div className="panel" data-testid="sub-invalid">
          <h3>{t('sub.invalidTitle')}</h3>
          <p className="lead">{t('sub.invalidBody')}</p>
          <a className="btn" href="/" style={{ textAlign: 'center', textDecoration: 'none' }}>
            {t('sub.backToForm')}
          </a>
        </div>
      )}
      {err && err.kind !== 'notFound' && (
        <div className="panel">
          <p className="form-err light" role="alert">
            {t(...errorText(err))}{' '}
            <button type="button" className="linkbtn" onClick={go}>
              {t('common.retry')}
            </button>
          </p>
        </div>
      )}
    </SimplePage>
  );
}
