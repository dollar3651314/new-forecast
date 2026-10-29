/**
 * 名单页（只给 Amos）：一个密码登录（没有账号）→ 验证指标（M-9）、来源转化、名单（打码，可筛内测）、焦点战增删改（M-2）、导出（再输一次密码）、登出。
 * - 每一块单独读取，各有"读取中 / 出错 + 重试"，一块慢不拖垮整页（C41、C52）。
 * - 手机和电脑分开排版（C64）：名单和焦点战电脑是表格，手机是一项一张卡片。
 * - 焦点战的校验和后端同一份（shared/rules.ts validateMatch，C108），保存前就标出每个字段的错误，一次全部提示（C56）。
 * 接口见 site/worker/src/admin.ts。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatTaiwanTime, MATCH_LIMITS, validateMatch, type MatchFieldError, type MatchInput } from '../../../shared/rules';
import { Logo } from '../components/Chrome';
import { api, type ApiError } from '../lib/api';
import { useIsDesktop } from '../lib/site';
import TEXT from './texts.json';

type TextKey = Exclude<keyof typeof TEXT, '_说明'>;
export function tx(key: TextKey, vars: Record<string, string | number> = {}): string {
  return TEXT[key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

function errText(e: ApiError): string {
  if (e.kind === 'rateLimited') return tx('locked', { minutes: Math.max(1, Math.ceil(e.seconds / 60)) });
  if (e.kind === 'network') return tx('network');
  if (e.kind === 'unauthorized') return e.code === 'WRONG_PASSWORD' ? tx('wrong') : tx('expired');
  return tx('server');
}

export function AdminApp() {
  const [state, setState] = useState<'checking' | 'login' | 'in' | 'error'>('checking');
  const [env, setEnv] = useState('');
  const check = useCallback(() => {
    setState('checking');
    void api<{ ok: boolean; environment: string }>('/api/admin/session').then((r) => {
      if (r.ok) {
        setEnv(r.data.environment);
        setState('in');
      } else setState(r.error.kind === 'unauthorized' ? 'login' : 'error');
    });
  }, []);
  useEffect(check, [check]);
  const logout = async () => {
    await api('/api/admin/logout', { body: {} });
    setState('login');
  };
  return (
    <>
      {env && env !== 'production' && (
        <div className="envbar" role="note" data-testid="env-banner">
          测试环境（{env}）
        </div>
      )}
      <div className="top">
        <div className="wrap">
          <div className="bar">
            <Logo suffix="名单" />
            {state === 'in' && (
              <button type="button" className="pill btnpill" onClick={logout} data-testid="logout">
                {tx('logout')}
              </button>
            )}
          </div>
        </div>
      </div>
      <main className="wrap admin">
        {state === 'checking' && <p>…</p>}
        {state === 'error' && (
          <p className="form-err light" role="alert">
            {tx('server')}{' '}
            <button type="button" className="linkbtn" onClick={check}>
              {tx('retry')}
            </button>
          </p>
        )}
        {state === 'login' && <Login onDone={check} />}
        {state === 'in' && <Dashboard onExpired={() => setState('login')} />}
      </main>
    </>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await api('/api/admin/login', { body: { password: pw } });
    setBusy(false);
    setPw('');
    if (r.ok) return onDone();
    setErr(errText(r.error));
  }
  return (
    <form className="panel login" onSubmit={submit} data-testid="admin-login">
      <h3>{tx('loginTitle')}</h3>
      <p className="lead">{tx('loginLead')}</p>
      <label htmlFor="pw">{tx('password')}</label>
      <input id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
      <button className="btn" type="submit" disabled={busy || !pw}>
        {busy ? tx('loggingIn') : tx('login')}
      </button>
      {err && (
        <p className="form-err light" role="alert">
          {err}
        </p>
      )}
    </form>
  );
}

type Load<T> = { state: 'loading' } | { state: 'error'; error: ApiError } | { state: 'ok'; data: T };

function useAdminLoad<T>(path: string, onExpired: () => void): [Load<T>, () => void] {
  const [s, setS] = useState<Load<T>>({ state: 'loading' });
  const load = useCallback(() => {
    setS({ state: 'loading' });
    void api<T>(path).then((r) => {
      if (!r.ok && r.error.kind === 'unauthorized') return onExpired();
      setS(r.ok ? { state: 'ok', data: r.data } : { state: 'error', error: r.error });
    });
  }, [path, onExpired]);
  useEffect(load, [load]);
  return [s, load];
}

function Failed({ retry }: { retry: () => void }) {
  return (
    <p className="form-err light" role="alert">
      {tx('loadError')}{' '}
      <button type="button" className="linkbtn" onClick={retry}>
        {tx('retry')}
      </button>
    </p>
  );
}

function Dashboard({ onExpired }: { onExpired: () => void }) {
  return (
    <>
      <Metrics onExpired={onExpired} />
      <Subscribers onExpired={onExpired} />
      <MatchesEditor onExpired={onExpired} />
      <Export />
    </>
  );
}

interface MetricsData {
  confirmed: number;
  pending: number;
  unsubscribed: number;
  beta: number;
  todayNew: number;
  avg7: number;
  channels: { channel: string; visits: number; confirmed: number; beta: number; rate: string | null }[];
}

function channelName(c: string): string {
  if (c === 'invite') return tx('chInvite');
  return c || tx('chNone');
}

function Metrics({ onExpired }: { onExpired: () => void }) {
  const [m, reload] = useAdminLoad<MetricsData>('/api/admin/metrics', onExpired);
  return (
    <section className="blk" data-testid="metrics">
      <h3>{tx('metricsTitle')}</h3>
      <p className="lead">{tx('metricsLead')}</p>
      {m.state === 'loading' && <p>…</p>}
      {m.state === 'error' && <Failed retry={reload} />}
      {m.state === 'ok' && (
        <>
          <div className="kpis">
            <div className="kpi">
              <div className="k">{tx('kConfirmed')}</div>
              <div className="v" data-testid="kpi-confirmed">
                {m.data.confirmed}
              </div>
              <div className="goal">{tx('kConfirmedGoal')}</div>
            </div>
            <div className="kpi">
              <div className="k">{tx('kToday')}</div>
              <div className="v" data-testid="kpi-today">
                {m.data.todayNew}
              </div>
              <div className="goal">{tx('kTodayGoal', { avg: m.data.avg7 })}</div>
            </div>
            <div className="kpi">
              <div className="k">{tx('kBeta')}</div>
              <div className="v" data-testid="kpi-beta">
                {m.data.beta}
              </div>
              <div className="goal">{tx('kBetaGoal')}</div>
            </div>
            <div className="kpi">
              <div className="k">{tx('kFollow')}</div>
              <div className="v">—</div>
              <div className="goal">{tx('kFollowGoal')}</div>
            </div>
          </div>
          <p className="small muted">{tx('kOther', { pending: m.data.pending, unsub: m.data.unsubscribed })}</p>
          <h4>{tx('chTitle')}</h4>
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>{tx('chSource')}</th>
                  <th className="n">{tx('chVisits')}</th>
                  <th className="n">{tx('chConfirmed')}</th>
                  <th className="n">{tx('chRate')}</th>
                  <th className="n">{tx('chBeta')}</th>
                </tr>
              </thead>
              <tbody data-testid="channels">
                {m.data.channels.map((c) => (
                  <tr key={c.channel}>
                    <td>{channelName(c.channel)}</td>
                    <td className="n">{c.visits}</td>
                    <td className="n">{c.confirmed}</td>
                    <td className="n">{c.rate ?? '—'}</td>
                    <td className="n">{c.beta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">{tx('chNote')}</p>
        </>
      )}
    </section>
  );
}

interface Sub {
  id: number;
  email: string;
  lang: string;
  status: string;
  beta: boolean;
  channel: string;
  invites: number;
  createdAt: string;
  confirmedAt: string | null;
}

const STATUS_TEXT: Record<string, string> = { confirmed: TEXT.sConfirmed, pending: TEXT.sPending, unsubscribed: TEXT.sUnsubscribed };

function Subscribers({ onExpired }: { onExpired: () => void }) {
  const desktop = useIsDesktop();
  const [beta, setBeta] = useState(false);
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Sub[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [all, setAll] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const fetchPage = useCallback(
    async (before: number | null, reset: boolean) => {
      setState('loading');
      const q = new URLSearchParams();
      if (beta) q.set('beta', '1');
      if (status) q.set('status', status);
      if (before) q.set('before', String(before));
      const [r, a] = await Promise.all([
        api<{ total: number; next: number | null; items: Sub[] }>(`/api/admin/subscribers?${q}`),
        reset ? api<{ total: number }>('/api/admin/subscribers?before=1') : Promise.resolve(null),
      ]);
      if (!r.ok) {
        if (r.error.kind === 'unauthorized') return onExpired();
        return setState('error');
      }
      if (a && a.ok) setAll(a.data.total);
      setItems((old) => (reset ? r.data.items : [...old, ...r.data.items]));
      setTotal(r.data.total);
      setNext(r.data.next);
      setState('ok');
    },
    [beta, status, onExpired],
  );
  useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);
  const filtered = beta || status !== '';
  return (
    <section className="blk" data-testid="subscribers">
      <h3>{tx('listTitle')}</h3>
      <p className="lead">{tx('listLead')}</p>
      <div className="filters">
        <label className="chk dark">
          <input type="checkbox" checked={beta} onChange={(e) => setBeta(e.target.checked)} data-testid="filter-beta" /> {tx('fBeta')}
        </label>
        <label>
          <span className="sr">{tx('fStatus')}</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={tx('fStatus')}>
            <option value="">{tx('sAny')}</option>
            <option value="confirmed">{tx('sConfirmed')}</option>
            <option value="pending">{tx('sPending')}</option>
            <option value="unsubscribed">{tx('sUnsubscribed')}</option>
          </select>
        </label>
        {total !== null && <span className="muted small" data-testid="list-total">{tx('total', { n: total })}</span>}
      </div>
      {state === 'error' && <Failed retry={() => void fetchPage(null, true)} />}
      {state !== 'error' && items.length === 0 && state === 'ok' && (
        <p className="empty">{filtered && all ? tx('emptyFiltered', { n: all }) : tx('empty')}</p>
      )}
      {items.length > 0 &&
        (desktop ? (
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>{tx('cEmail')}</th>
                  <th>{tx('cStatus')}</th>
                  <th>{tx('cBeta')}</th>
                  <th>{tx('cSource')}</th>
                  <th className="n">{tx('cInvites')}</th>
                  <th>{tx('cLang')}</th>
                  <th>{tx('cCreated')}</th>
                  <th>{tx('cConfirmed')}</th>
                </tr>
              </thead>
              <tbody data-testid="sub-rows">
                {items.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.email}</td>
                    <td>{STATUS_TEXT[s.status] ?? s.status}</td>
                    <td>{s.beta ? tx('yes') : tx('no')}</td>
                    <td>{channelName(s.channel)}</td>
                    <td className="n">{s.invites}</td>
                    <td>{s.lang}</td>
                    <td className="mono">{formatTaiwanTime(s.createdAt)}</td>
                    <td className="mono">{s.confirmedAt ? formatTaiwanTime(s.confirmedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="cards" data-testid="sub-rows">
            {items.map((s) => (
              <div className="card" key={s.id}>
                <div className="mono strong">{s.email}</div>
                <div className="small">
                  {STATUS_TEXT[s.status] ?? s.status} · {tx('cBeta')} {s.beta ? tx('yes') : tx('no')} · {channelName(s.channel)} · {tx('cInvites')} {s.invites}
                </div>
                <div className="small muted mono">{formatTaiwanTime(s.createdAt)}</div>
              </div>
            ))}
          </div>
        ))}
      {items.length > 0 && <p className="small muted">{tx('shown', { n: items.length })}</p>}
      {next && (
        <button type="button" className="btn ghost-dark" onClick={() => void fetchPage(next, false)} disabled={state === 'loading'}>
          {tx('more')}
        </button>
      )}
    </section>
  );
}

interface MatchRow {
  id: number;
  league: string;
  title: string;
  startsAt: string;
  startsAtTw: string;
  note: string;
  visible: boolean;
}

type Draft = Required<MatchInput>;
const EMPTY: Draft = { league: '', title: '', startsAt: '', note: '' };
type Errors = Partial<Record<keyof MatchInput, MatchFieldError>>;

function MatchForm({ initial, onSave, onCancel, saveLabel }: { initial: Draft; onSave: (d: Draft) => Promise<Errors | string | null>; onCancel?: () => void; saveLabel: string }) {
  const [d, setD] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const v = validateMatch(d, Date.now());
    if (!v.ok) {
      setErrors(v.errors);
      setMsg(tx('eFix', { n: Object.keys(v.errors).length }));
      return;
    }
    setErrors({});
    setBusy(true);
    const r = await onSave(d);
    setBusy(false);
    if (r === null) {
      if (!onCancel) setD(EMPTY);
      return;
    }
    if (typeof r === 'string') setMsg(r);
    else {
      setErrors(r);
      setMsg(tx('eFix', { n: Object.keys(r).length }));
    }
  }
  const field = (k: keyof MatchInput, label: string, placeholder = '') => (
    <label className={`mf ${errors[k] ? 'bad' : ''}`}>
      <span>{label}</span>
      <input
        value={d[k]}
        placeholder={placeholder}
        aria-invalid={errors[k] ? true : undefined}
        onChange={(e) => {
          setD({ ...d, [k]: e.target.value });
          if (errors[k]) setErrors({ ...errors, [k]: undefined });
        }}
        data-testid={`m-${k}`}
      />
      {errors[k] && <em role="alert">{tx(`e${errors[k]}` as TextKey)}</em>}
    </label>
  );
  return (
    <form className="mform" onSubmit={submit} noValidate>
      {field('league', tx('mLeague'), 'NBA')}
      {field('title', tx('mTitleField'), '湖人 vs 勇士')}
      {field('startsAt', tx('mTime'), '2026-11-02 10:30')}
      {field('note', tx('mNote'))}
      <div className="mbtns">
        <button className="btn" type="submit" disabled={busy} data-testid="m-save">
          {saveLabel}
        </button>
        {onCancel && (
          <button className="btn ghost-dark" type="button" onClick={onCancel}>
            {tx('mCancel')}
          </button>
        )}
      </div>
      {msg && (
        <p className="form-err light" role="alert">
          {msg}
        </p>
      )}
    </form>
  );
}

function MatchesEditor({ onExpired }: { onExpired: () => void }) {
  const desktop = useIsDesktop();
  const [m, reload] = useAdminLoad<{ items: MatchRow[]; max: number }>('/api/admin/matches', onExpired);
  const [editing, setEditing] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const save = (id: number | null) => async (d: Draft): Promise<Errors | string | null> => {
    const r = await api<MatchRow>(id === null ? '/api/admin/matches' : `/api/admin/matches/${id}`, { method: id === null ? 'POST' : 'PUT', body: d });
    if (r.ok) {
      setEditing(null);
      setFlash(tx('mSaved'));
      reload();
      return null;
    }
    if (r.error.kind === 'validation') return Object.fromEntries(r.error.fields.map((f) => [f.field, f.code])) as Errors;
    if (r.error.kind === 'conflict') return tx('mFull', { max: MATCH_LIMITS.max });
    if (r.error.kind === 'notFound') {
      reload();
      return tx('eNotFound');
    }
    if (r.error.kind === 'unauthorized') {
      onExpired();
      return null;
    }
    return errText(r.error);
  };

  async function remove(row: MatchRow) {
    if (!confirm(tx('mDeleteConfirm', { title: row.title }))) return;
    const r = await api(`/api/admin/matches/${row.id}`, { method: 'DELETE' });
    if (!r.ok && r.error.kind === 'unauthorized') return onExpired();
    setFlash(r.ok || r.error.kind === 'notFound' ? tx('mDeleted') : errText(r.error));
    reload();
  }

  const items = m.state === 'ok' ? m.data.items : [];
  const draftOf = (x: MatchRow): Draft => ({ league: x.league, title: x.title, startsAt: x.startsAtTw, note: x.note });
  return (
    <section className="blk" data-testid="matches-editor">
      <h3>{tx('mTitle')}</h3>
      <p className="lead">{tx('mLead')}</p>
      {flash && (
        <p className="ok-msg" role="status">
          {flash}
        </p>
      )}
      {m.state === 'loading' && <p>…</p>}
      {m.state === 'error' && <Failed retry={reload} />}
      {m.state === 'ok' && (
        <>
          <p className="small muted">{tx('mCount', { n: items.length, max: m.data.max })}</p>
          {items.length === 0 && <p className="empty">{tx('mEmpty')}</p>}
          {items.length > 0 && desktop && (
            <div className="tbl">
              <table>
                <thead>
                  <tr>
                    <th>{tx('mLeague')}</th>
                    <th>{tx('mTitleField')}</th>
                    <th>{tx('mTime')}</th>
                    <th>{tx('mNote')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody data-testid="match-rows">
                  {items.map((x) =>
                    editing === x.id ? (
                      <tr key={x.id}>
                        <td colSpan={5}>
                          <MatchForm initial={draftOf(x)} onSave={save(x.id)} onCancel={() => setEditing(null)} saveLabel={tx('mSave')} />
                        </td>
                      </tr>
                    ) : (
                      <tr key={x.id} className={x.visible ? '' : 'dim'}>
                        <td>{x.league}</td>
                        <td>
                          {x.title}
                          {!x.visible && <div className="small muted">{tx('mHidden')}</div>}
                        </td>
                        <td className="mono">{x.startsAtTw}</td>
                        <td>{x.note || '—'}</td>
                        <td className="acts">
                          <button type="button" className="linkbtn" onClick={() => setEditing(x.id)}>
                            {tx('mEdit')}
                          </button>
                          <button type="button" className="linkbtn danger" onClick={() => void remove(x)}>
                            {tx('mDelete')}
                          </button>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
          {items.length > 0 && !desktop && (
            <div className="cards" data-testid="match-rows">
              {items.map((x) =>
                editing === x.id ? (
                  <div className="card" key={x.id}>
                    <MatchForm initial={draftOf(x)} onSave={save(x.id)} onCancel={() => setEditing(null)} saveLabel={tx('mSave')} />
                  </div>
                ) : (
                  <div className={`card ${x.visible ? '' : 'dim'}`} key={x.id}>
                    <div className="small muted">{x.league}</div>
                    <div className="strong">{x.title}</div>
                    <div className="mono small">{x.startsAtTw}</div>
                    {x.note && <div className="small">{x.note}</div>}
                    {!x.visible && <div className="small muted">{tx('mHidden')}</div>}
                    <div className="acts">
                      <button type="button" className="linkbtn" onClick={() => setEditing(x.id)}>
                        {tx('mEdit')}
                      </button>
                      <button type="button" className="linkbtn danger" onClick={() => void remove(x)}>
                        {tx('mDelete')}
                      </button>
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
          <h4>{tx('mAdd')}</h4>
          {items.length >= m.data.max ? <p className="muted">{tx('mFull', { max: m.data.max })}</p> : <MatchForm initial={EMPTY} onSave={save(null)} saveLabel={tx('mAdd')} />}
        </>
      )}
    </section>
  );
}

interface ExportPage {
  format: string;
  exportedAt: string;
  environment: string;
  next: number | null;
  count: number;
  items: unknown[];
}

function Export() {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    // 密码只在这次导出里用，取完就清掉；名单超过一份（2000 人）时自动接着取，合成一个文件
    const password = pw;
    setPw('');
    const items: unknown[] = [];
    let after = 0;
    let first: ExportPage | null = null;
    for (let page = 1; ; page++) {
      setBusy(page);
      const r = await api<ExportPage>('/api/admin/export', { body: { password, after } });
      if (!r.ok) {
        setBusy(null);
        setMsg({ ok: false, text: errText(r.error) });
        return;
      }
      first ??= r.data;
      items.push(...r.data.items);
      if (r.data.next === null) break;
      after = r.data.next;
    }
    setBusy(null);
    const file = { format: first!.format, exportedAt: first!.exportedAt, environment: first!.environment, count: items.length, items };
    const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quickcome-waitlist-${first!.environment}-${first!.exportedAt.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    setMsg({ ok: true, text: tx('exDone', { n: items.length }) });
  }
  return (
    <section className="blk" data-testid="export">
      <h3>{tx('exTitle')}</h3>
      <p className="lead">{tx('exLead')}</p>
      <form className="exform" onSubmit={submit}>
        <label htmlFor="expw">{tx('password')}</label>
        <input id="expw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required data-testid="export-pw" />
        <button className="btn" type="submit" disabled={busy !== null || !pw} data-testid="export-btn">
          {busy !== null ? tx('exWorking', { page: busy }) : tx('exButton')}
        </button>
      </form>
      {msg && (
        <p className={msg.ok ? 'ok-msg' : 'form-err light'} role={msg.ok ? 'status' : 'alert'} data-testid="export-msg">
          {msg.text}
        </p>
      )}
    </section>
  );
}
