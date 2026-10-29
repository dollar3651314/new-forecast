/** M-10：专属邀请链接 + "你邀请了几个人"（确认页和邀请查看页共用）。 */
import { useState } from 'react';
import { useI18n } from '../i18n';

export interface InviteInfo {
  code: string;
  key: string;
  link: string;
  count: number;
}

export function InvitePanel({ invite, showPrivateLink }: { invite: InviteInfo; showPrivateLink?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 复制不了时用户可以手动选取 */
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
        <button type="button" className="btn small-btn" onClick={copy}>
          {copied ? t('invite.copied') : t('invite.copy')}
        </button>
      </div>
      <p className="count" data-testid="invite-count">
        {t('invite.count', { n: invite.count })}
      </p>
      <p className="small muted">{t('invite.countHint')}</p>
      {showPrivateLink && (
        <p className="small muted">
          {t('invite.private')} <a href={`/invite?k=${invite.key}`}>{t('invite.privateLink')}</a>
        </p>
      )}
    </div>
  );
}
