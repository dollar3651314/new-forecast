/**
 * 留邮箱表单（M-6 愿意内测）。邮箱规则和后端同一份（shared/rules.ts validateEmail，C108）：送出前就在输入框下面标出错误。
 * 陷阱字段 website 对人看不见（屏幕阅读器也跳过），机器人填了后端照样回答但不记。
 */
import { useState, type FormEvent } from 'react';
import { validateEmail } from '../../../shared/rules';
import { useI18n } from '../i18n';
import { api, errorText } from '../lib/api';
import type { Attribution } from '../lib/attribution';

export function SubscribeForm({ attribution }: { attribution: Attribution }) {
  const { t, lang } = useI18n();
  const [email, setEmail] = useState('');
  const [beta, setBeta] = useState(false);
  const [website, setWebsite] = useState('');
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const emailMsg = (code: string) => (code === 'REQUIRED' ? t('form.errRequired') : t('form.errEmail'));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormErr(null);
    const fe = validateEmail(email);
    setFieldErr(fe ? emailMsg(fe) : null);
    if (fe) return;
    setBusy(true);
    const r = await api<{ status: string }>('/api/public/subscribe', { body: { email, lang, beta, website, ...attribution } });
    setBusy(false);
    if (r.ok) {
      setDone(email.trim());
      return;
    }
    if (r.error.kind === 'validation') {
      const f = r.error.fields.find((x) => x.field === 'email');
      setFieldErr(emailMsg(f?.code ?? 'EMAIL_INVALID'));
      return;
    }
    const [k, v] = errorText(r.error);
    setFormErr(t(k, v));
  }

  if (done) {
    return (
      <div className="form" data-testid="subscribe-done" role="status">
        <h2>{t('form.doneTitle')}</h2>
        <p>{t('form.doneBody', { email: done })}</p>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setDone(null);
            setEmail('');
          }}
        >
          {t('form.again')}
        </button>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={submit} noValidate data-testid="subscribe-form">
      <h2>{t('form.title')}</h2>
      <p>{t('form.lead')}</p>
      <label htmlFor="em">{t('form.email')}</label>
      <input
        id="em"
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder={t('form.placeholder')}
        value={email}
        aria-invalid={fieldErr ? true : undefined}
        aria-describedby={fieldErr ? 'em-err' : undefined}
        onChange={(e) => {
          setEmail(e.target.value);
          if (fieldErr) setFieldErr(null);
        }}
      />
      {fieldErr && (
        <div id="em-err" className="field-err" role="alert">
          {fieldErr}
        </div>
      )}
      <div className="hp" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>
      <label className="chk">
        <input type="checkbox" checked={beta} onChange={(e) => setBeta(e.target.checked)} /> {t('form.beta')}
      </label>
      <button className="btn" type="submit" disabled={busy}>
        {busy ? t('form.submitting') : t('form.submit')}
      </button>
      {formErr && (
        <div className="form-err" role="alert">
          {formErr}
        </div>
      )}
      <div className="small">{t('form.small')}</div>
    </form>
  );
}
