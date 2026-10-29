/**
 * 名单页（只给 Amos）：一个密码登录（没有账号）→ 验证指标、来源转化、邀请排行、名单（打码，可筛内测）、焦点战增删改和批量导入、导出 Excel（再输一次密码）、登出。
 * - 页面上不出现内部编号和英文技术词；来源显示人看得懂的名字（shared/rules.ts channelLabel）（v1.1 Amos 验收）。
 * - 密码错、被锁一律显示同一句"登录失败，请稍后再试"，不说明规则（v1.1）。
 * - 每一块单独读取，各有"读取中 / 出错 + 重试"，一块慢不拖垮整页（C41、C52）。
 * - 手机和电脑分开排版（C64）：名单和焦点战电脑是表格，手机是一项一张卡片。
 * - 焦点战的校验和后端同一份（shared/rules.ts validateMatch，C108），保存前就标出每个字段的错误，一次全部提示（C56）。
 * 接口见 site/worker/src/admin.ts。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  channelLabel,
  formatTaiwanTime,
  MATCH_LEAGUES,
  MATCH_LIMITS,
  OTHER_LEAGUE,
  taiwanPickerValue,
  validateMatch,
  type MatchField,
  type MatchFieldError,
} from '../../../shared/rules';
import { Logo } from '../components/Chrome';
import { api, type ApiError } from '../lib/api';
import { useIsDesktop } from '../lib/site';
import TEXT from './texts.json';
import { downloadExport, downloadTemplate, FIELD_ORDER, parseMatchRows, previewImport, readTable, type ExportItem, type ParsedRow } from './xlsx';

type TextKey = Exclude<keyof typeof TEXT, '_说明'>;
export function tx(key: TextKey, vars: Record<string, string | number> = {}): string {
  return TEXT[key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * 名单页接口的前缀：名单页的地址（密钥 ADMIN_PATH，只有 Worker 和打开这一页的人知道）+ /api。
 * 地址不写在代码里，从当前页面的地址取（v1.1，Amos："后台不要用 /admin 这样容易猜的地址"）。
 */
export function apiBase(): string {
  return `${location.pathname.replace(/\/+$/, '')}/api`;
}

function errText(e: ApiError): string {
  if (e.kind === 'network') return tx('network');
  if (e.kind === 'unauthorized') return e.code === 'AUTH_FAILED' ? tx('authFailed') : tx('expired');
  return tx('server');
}

export function AdminApp() {
  const [state, setState] = useState<'checking' | 'login' | 'in' | 'error'>('checking');
  const [env, setEnv] = useState('');
  const check = useCallback(() => {
    setState('checking');
    void api<{ ok: boolean; environment: string }>(`${apiBase()}/session`).then((r) => {
      if (r.ok) {
        setEnv(r.data.environment);
        setState('in');
      } else setState(r.error.kind === 'unauthorized' ? 'login' : 'error');
    });
  }, []);
  useEffect(check, [check]);
  const logout = async () => {
    await api(`${apiBase()}/logout`, { body: {} });
    setState('login');
  };
  return (
    <>
      {env && env !== 'production' && (
        <div className="envbar" role="note" data-testid="env-banner">
          {tx('envBanner')}
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
    const r = await api(`${apiBase()}/login`, { body: { password: pw } });
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
  inviters: { email: string; count: number }[];
}

const source = (c: string) => channelLabel(c, 'zh-CN');

function Metrics({ onExpired }: { onExpired: () => void }) {
  const [m, reload] = useAdminLoad<MetricsData>(`${apiBase()}/metrics`, onExpired);
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
              <div className="goal" data-testid="kpi-beta-note">
                {m.data.beta === 0 ? tx('kBetaZero') : tx('kBetaGoal')}
              </div>
            </div>
            <div className="kpi">
              <div className="k">{tx('kFollow')}</div>
              <div className="v">—</div>
              <div className="goal">{tx('kFollowGoal')}</div>
            </div>
          </div>
          <p className="small muted">{tx('kOther', { pending: m.data.pending, unsub: m.data.unsubscribed })}</p>
          <div className="two">
            <div>
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
                        <td>{source(c.channel)}</td>
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
            </div>
            <div data-testid="inviters">
              <h4>{tx('invTitle')}</h4>
              <p className="small muted">{tx('invLead')}</p>
              {m.data.inviters.length === 0 ? (
                <p className="empty">{tx('invEmpty')}</p>
              ) : (
                <div className="tbl">
                  <table>
                    <thead>
                      <tr>
                        <th>{tx('invWho')}</th>
                        <th className="n">{tx('invCount')}</th>
                      </tr>
                    </thead>
                    <tbody data-testid="inviter-rows">
                      {m.data.inviters.map((x, i) => (
                        <tr key={i}>
                          <td className="mono">{x.email}</td>
                          <td className="n">{x.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
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
  inviter: string | null;
  invites: number;
  createdAt: string;
  confirmedAt: string | null;
}

const STATUS_TEXT: Record<string, string> = { confirmed: TEXT.sConfirmed, pending: TEXT.sPending, unsubscribed: TEXT.sUnsubscribed };
const LANG_TEXT: Record<string, string> = { 'zh-TW': TEXT.langZhTW, 'zh-CN': TEXT.langZhCN, en: TEXT.langEn };

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
        api<{ total: number; next: number | null; items: Sub[] }>(`${apiBase()}/subscribers?${q}`),
        reset ? api<{ total: number }>(`${apiBase()}/subscribers?before=1`) : Promise.resolve(null),
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
  const emptyText = beta && status === '' ? tx('emptyBeta') : filtered && all ? tx('emptyFiltered', { n: all }) : tx('empty');
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
        <p className="empty" data-testid="list-empty">
          {emptyText}
        </p>
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
                  <th>{tx('cInviter')}</th>
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
                    <td>{source(s.channel)}</td>
                    <td className="mono">{s.inviter ?? '—'}</td>
                    <td className="n">{s.invites}</td>
                    <td>{LANG_TEXT[s.lang] ?? s.lang}</td>
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
                  {STATUS_TEXT[s.status] ?? s.status} · {tx('cBeta')} {s.beta ? tx('yes') : tx('no')} · {source(s.channel)}
                  {s.inviter ? ` · ${tx('cInviter')} ${s.inviter}` : ''} · {tx('cInvites')} {s.invites}
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
  home: string;
  away: string;
  title: string;
  startsAt: string;
  startsAtTw: string;
  note: string;
  visible: boolean;
}

/** 编辑中的一场：联赛下拉（"其他"时另填名称）、主队、客队、开赛时间（日期时间选择器，台湾时间）、备注 */
interface Draft {
  leagueChoice: string;
  leagueOther: string;
  home: string;
  away: string;
  startsAt: string;
  note: string;
}
const EMPTY: Draft = { leagueChoice: '', leagueOther: '', home: '', away: '', startsAt: '', note: '' };
type Errors = Partial<Record<MatchField, MatchFieldError>>;

const leagueOf = (d: Draft) => (d.leagueChoice === OTHER_LEAGUE ? d.leagueOther : d.leagueChoice);
const toBody = (d: Draft) => ({ league: leagueOf(d), home: d.home, away: d.away, startsAt: d.startsAt, note: d.note });

function MatchForm({ initial, onSave, onCancel, saveLabel }: { initial: Draft; onSave: (d: Draft) => Promise<Errors | string | null>; onCancel?: () => void; saveLabel: string }) {
  const [d, setD] = useState<Draft>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const v = validateMatch(toBody(d), Date.now());
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
  const set = (patch: Partial<Draft>, field: MatchField) => {
    setD({ ...d, ...patch });
    if (errors[field]) setErrors({ ...errors, [field]: undefined });
  };
  const err = (k: MatchField) => errors[k] && <em role="alert">{tx(`e${errors[k]}` as TextKey)}</em>;
  const text = (k: 'home' | 'away' | 'note', label: string, placeholder = '') => (
    <label className={`mf ${errors[k] ? 'bad' : ''}`}>
      <span>{label}</span>
      <input value={d[k]} placeholder={placeholder} aria-invalid={errors[k] ? true : undefined} onChange={(e) => set({ [k]: e.target.value }, k)} data-testid={`m-${k}`} />
      {err(k)}
    </label>
  );
  return (
    <form className="mform" onSubmit={submit} noValidate>
      <label className={`mf ${errors.league ? 'bad' : ''}`}>
        <span>{tx('mLeague')}</span>
        <select value={d.leagueChoice} aria-invalid={errors.league ? true : undefined} onChange={(e) => set({ leagueChoice: e.target.value }, 'league')} data-testid="m-league">
          <option value="">{tx('mLeaguePick')}</option>
          {[...MATCH_LEAGUES, OTHER_LEAGUE].map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        {d.leagueChoice === OTHER_LEAGUE && (
          <input value={d.leagueOther} placeholder={tx('mLeagueOther')} aria-label={tx('mLeagueOther')} onChange={(e) => set({ leagueOther: e.target.value }, 'league')} data-testid="m-league-other" />
        )}
        {err('league')}
      </label>
      {text('home', tx('mHome'), '湖人')}
      {text('away', tx('mAway'), '勇士')}
      <label className={`mf ${errors.startsAt ? 'bad' : ''}`}>
        <span>{tx('mTime')}</span>
        <input type="datetime-local" value={d.startsAt} aria-invalid={errors.startsAt ? true : undefined} onChange={(e) => set({ startsAt: e.target.value }, 'startsAt')} data-testid="m-startsAt" />
        {err('startsAt')}
      </label>
      {text('note', tx('mNote'))}
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

const FIELD_NAME: Record<MatchField, string> = { league: TEXT.mLeague, home: TEXT.mHome, away: TEXT.mAway, startsAt: TEXT.mTime, note: TEXT.mNote };

/** 批量导入：下载模板 → 选择文件 → 预览（每行的检查结果、导入后保留哪几场）→ 确认导入 */
function MatchImport({ existing, max, onDone, onExpired }: { existing: MatchRow[]; max: number; onDone: (n: number) => void; onExpired: () => void }) {
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [replace, setReplace] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<'reading' | 'saving' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  async function choose(file: File | undefined) {
    if (!file) return;
    setMsg(null);
    setRows(null);
    setBusy('reading');
    try {
      const p = parseMatchRows(await readTable(file), Date.now());
      if (!p.ok) setMsg({ ok: false, text: p.reason === 'empty' ? tx('impEmpty') : tx('impBadHeader', { missing: p.missing.join('、') }) });
      else setRows(p.rows);
    } catch {
      setMsg({ ok: false, text: tx('impBadFile') });
    }
    setBusy(null);
    if (fileRef.current) fileRef.current.value = '';
  }
  const bad = rows ? rows.filter((r) => !r.value) : [];
  const pv = rows ? previewImport(rows, existing, replace, Date.now()) : null;
  async function save() {
    if (!rows || bad.length) return;
    setBusy('saving');
    setMsg(null);
    const r = await api<{ imported: number }>(`${apiBase()}/matches/import`, { body: { items: rows.map((x) => x.input), replace } });
    setBusy(null);
    if (r.ok) {
      setRows(null);
      setReplace(false);
      onDone(r.data.imported);
      return;
    }
    if (r.error.kind === 'unauthorized') return onExpired();
    if (r.error.kind === 'validation') {
      // 前端已经用同一套规则检查过；这里只在两边判断不一致时出现（例如跨过了某一刻的时间）
      const lines = r.error.fields.map((f) => {
        const [i, field] = f.field.split('.');
        const row = rows[Number(i)];
        return tx('impLineErr', { line: row?.line ?? '?', field: FIELD_NAME[field as MatchField] ?? field, msg: tx(`e${f.code}` as TextKey) });
      });
      return setMsg({ ok: false, text: lines.join('；') });
    }
    setMsg({ ok: false, text: errText(r.error) });
  }
  return (
    <div className="import" data-testid="match-import">
      <h4>{tx('impTitle')}</h4>
      <p className="small muted">{tx('impLead')}</p>
      <div className="btns">
        <button type="button" className="btn ghost-dark" onClick={() => void downloadTemplate()} data-testid="imp-template">
          {tx('impTemplate')}
        </button>
        <label className="btn ghost-dark filebtn">
          {busy === 'reading' ? tx('impReading') : tx('impChoose')}
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={(e) => void choose(e.target.files?.[0])} data-testid="imp-file" />
        </label>
      </div>
      {rows && pv && (
        <div className="preview" data-testid="imp-preview">
          <p className="strong">{tx('impPreview', { n: rows.length })}</p>
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th className="n">{tx('impRow')}</th>
                  <th>{tx('mLeague')}</th>
                  <th>{tx('mVs')}</th>
                  <th>{tx('mTime')}</th>
                  <th>{tx('impStatus')}</th>
                </tr>
              </thead>
              <tbody data-testid="imp-rows">
                {rows.map((r) => (
                  <tr key={r.line} className={r.value ? (pv.dropLines.has(r.line) ? 'dim' : '') : 'bad'}>
                    <td className="n">{r.line}</td>
                    <td>{r.input.league || '—'}</td>
                    <td>
                      {r.input.home || '—'} vs {r.input.away || '—'}
                    </td>
                    <td className="mono">{r.value ? formatTaiwanTime(r.value.startsAt) : r.input.startsAt || '—'}</td>
                    <td>
                      {r.value ? (
                        pv.dropLines.has(r.line) ? (
                          tx('impWillDrop', { max })
                        ) : (
                          <span className="ok-msg">{tx('impWillKeep')}</span>
                        )
                      ) : (
                        <ul className="errs">
                          {FIELD_ORDER.filter((f) => r.errors[f]).map((f) => (
                            <li key={f}>{tx('impLineErr', { line: r.line, field: FIELD_NAME[f], msg: tx(`e${r.errors[f]}` as TextKey) })}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pv.removed.map((x) => (
            <p className="small muted" key={x.id}>
              {tx('impWillRemove', { title: x.title })}
            </p>
          ))}
          {bad.length > 0 && (
            <p className="form-err light" role="alert" data-testid="imp-errors">
              {tx('impErrors', { n: bad.length })}
            </p>
          )}
          {bad.length === 0 && pv.dropLines.size > 0 && <p className="small" data-testid="imp-toomany">{tx('impTooMany', { max })}</p>}
          <label className="chk dark">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} data-testid="imp-replace" /> {tx('impReplace')}
          </label>
          <div className="btns">
            <button type="button" className="btn" disabled={bad.length > 0 || busy !== null || pv.newCount === 0} onClick={() => void save()} data-testid="imp-confirm">
              {tx('impConfirm', { n: pv.newCount })}
            </button>
            <button type="button" className="btn ghost-dark" onClick={() => setRows(null)}>
              {tx('impCancel')}
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p className={msg.ok ? 'ok-msg' : 'form-err light'} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

function MatchesEditor({ onExpired }: { onExpired: () => void }) {
  const desktop = useIsDesktop();
  const [m, reload] = useAdminLoad<{ items: MatchRow[]; max: number }>(`${apiBase()}/matches`, onExpired);
  const [editing, setEditing] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const save = (id: number | null) => async (d: Draft): Promise<Errors | string | null> => {
    const r = await api<MatchRow>(id === null ? `${apiBase()}/matches` : `${apiBase()}/matches/${id}`, { method: id === null ? 'POST' : 'PUT', body: toBody(d) });
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
    const r = await api(`${apiBase()}/matches/${row.id}`, { method: 'DELETE' });
    if (!r.ok && r.error.kind === 'unauthorized') return onExpired();
    setFlash(r.ok || r.error.kind === 'notFound' ? tx('mDeleted') : errText(r.error));
    reload();
  }

  const items = m.state === 'ok' ? m.data.items : [];
  const draftOf = (x: MatchRow): Draft => {
    const known = (MATCH_LEAGUES as readonly string[]).includes(x.league);
    return {
      leagueChoice: known ? x.league : OTHER_LEAGUE,
      leagueOther: known ? '' : x.league,
      // 旧数据只有对战名（没有主客队）时，整段放进主队，让 Amos 拆开
      home: x.home || (x.away ? '' : x.title),
      away: x.away,
      startsAt: taiwanPickerValue(x.startsAt),
      note: x.note,
    };
  };
  return (
    <section className="blk" data-testid="matches-editor">
      <h3>{tx('mTitle')}</h3>
      <p className="lead">{tx('mLead')}</p>
      {flash && (
        <p className="ok-msg" role="status" data-testid="m-flash">
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
                    <th>{tx('mVs')}</th>
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
          <MatchImport
            existing={items}
            max={m.data.max}
            onExpired={onExpired}
            onDone={(n) => {
              setFlash(tx('impDone', { n }));
              reload();
            }}
          />
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
  items: ExportItem[];
}

function Export() {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    // 密码只在这次导出里用，取完就清掉；名单超过一批（2000 人）时自动接着取，合成一个文件
    const password = pw;
    setPw('');
    const items: ExportItem[] = [];
    let after = 0;
    let first: ExportPage | null = null;
    for (let page = 1; ; page++) {
      setBusy(page);
      const r = await api<ExportPage>(`${apiBase()}/export`, { body: { password, after } });
      if (!r.ok) {
        setBusy(null);
        setMsg({ ok: false, text: r.error.kind === 'unauthorized' && r.error.code === 'AUTH_FAILED' ? tx('exportAuthFailed') : errText(r.error) });
        return;
      }
      first ??= r.data;
      items.push(...r.data.items);
      if (r.data.next === null) break;
      after = r.data.next;
    }
    try {
      const file = await downloadExport(items, first!.exportedAt, first!.environment);
      setMsg({ ok: true, text: tx('exDone', { n: items.length, file }) });
    } catch {
      setMsg({ ok: false, text: tx('network') });
    }
    setBusy(null);
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
