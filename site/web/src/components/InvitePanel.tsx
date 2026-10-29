/** 专属邀请链接（一键复制）+ "你已邀请 N 人"（专属页面里用）。 */
import { useState } from 'react';
import { useI18n } from '../i18n';

export interface InviteInfo {
  code: string;
  link: string;
  count: number;
}

export function InvitePanel({ invite }: { invite: InviteInfo }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied('ok');
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // 复制不了（例如浏览器不允许）：告诉用户手动复制
      setCopied('fail');
    }
  }
  return (
    <div className="panel" data-testid="invite-panel">
      <h3 className="h-sm">{t('invite.title')}</h3>
      <p className="lead">{t('invite.lead')}</p>
      <div className="reflink-row">
        <div className="reflink" data-testid="invite-link">
          {invite.link}
        </div>
        <button type="button" className="btn small-btn" onClick={copy} data-testid="invite-copy">
          {copied === 'ok' ? t('invite.copied') : t('invite.copy')}
        </button>
      </div>
      {copied === 'fail' && <p className="small form-err light">{t('invite.copyFail')}</p>}
      <p className="count" data-testid="invite-count">
        {t('invite.count', { n: invite.count })}
      </p>
      <p className="small muted">{t('invite.countHint')}</p>
    </div>
  );
}
