/**
 * 首页的内容区块：M-1 返奖率对照、M-2 焦点战（含 BTC 每小时场）、M-3 怎么玩和算例、M-4 充值提醒、M-8 常见问题。
 * 手机和电脑分开排版（C64）：焦点战电脑是卡片网格、手机是一行一场的列表；怎么玩电脑三栏、手机一列。
 */
import { useCallback, useEffect, useState } from 'react';
import { poolExample } from '../../../shared/rules';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { kickoff, money, shortTime } from '../lib/format';
import { useIsDesktop } from '../lib/site';

export function ReturnRate() {
  const { t } = useI18n();
  return (
    <>
      <div className="cmp" role="group" aria-label={t('hero.cmpLabel')}>
        <div className="row">
          <span className="lab">{t('hero.lottery')}</span>
          <div className="track">
            <div className="fill" style={{ width: '78%', background: '#7B879E' }} />
          </div>
          <span className="num">{t('hero.lotteryValue')}</span>
        </div>
        <div className="row">
          <span className="lab">{t('hero.us')}</span>
          <div className="track">
            <div className="fill" style={{ width: '97.5%', background: 'var(--teal)' }} />
          </div>
          <span className="num">{t('hero.usValue')}</span>
        </div>
      </div>
      <p className="foot">{t('hero.foot')}</p>
    </>
  );
}

/** 首页的焦点战卡片只显示联赛、对战、开赛时间（台湾时间）；没有比例条（v1.1 Amos 验收） */
export interface Match {
  id: number;
  league: string;
  title: string;
  startsAt: string;
}

export interface Btc {
  available: boolean;
  price: string | null;
  hours: number;
  up: number;
  down: number;
  upPct: string | null;
  downPct: string | null;
  source: string | null;
  updatedAt: string | null;
}

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ok'; data: T };

function useLoad<T>(path: string): [Load<T>, () => void] {
  const [s, setS] = useState<Load<T>>({ state: 'loading' });
  const load = useCallback(() => {
    setS({ state: 'loading' });
    void api<T>(path).then((r) => setS(r.ok ? { state: 'ok', data: r.data } : { state: 'error' }));
  }, [path]);
  useEffect(load, [load]);
  return [s, load];
}

function BtcCard({ btc, desktop }: { btc: Load<{ btc: Btc }>; desktop: boolean }) {
  const { t } = useI18n();
  const b = btc.state === 'ok' ? btc.data.btc : null;
  const body =
    btc.state === 'loading' ? (
      <span className="note">{t('common.loading')}</span>
    ) : !b || !b.available ? (
      <span className="note">{t('matches.btcUnavailable')}</span>
    ) : (
      <>
        <span className="when">{t('matches.btcPrice', { price: money(b.price!) })}</span>
        <div className="split" role="img" aria-label={`${t('matches.upShare', { pct: b.upPct! })} / ${t('matches.downShare', { pct: b.downPct! })}`}>
          <span style={{ width: `${b.upPct}%` }} />
          <span style={{ width: `${b.downPct}%` }} />
        </div>
        <span className="note">{t('matches.btcStats', { hours: b.hours, up: b.up, down: b.down })}</span>
        <span className="note">{t('matches.btcSource', { source: b.source!, time: shortTime(b.updatedAt!) })}</span>
      </>
    );
  return (
    <div className={desktop ? 'g btc' : 'li btc'} data-testid="btc-card">
      <span className="lg">{t('matches.btcLeague')}</span>
      <span className="t">{t('matches.btcTitle')}</span>
      {body}
    </div>
  );
}

export function Matches() {
  const { t, lang } = useI18n();
  const desktop = useIsDesktop();
  const [m, reload] = useLoad<{ items: Match[] }>('/api/public/matches');
  const [btc] = useLoad<{ btc: Btc }>('/api/public/board');
  const items = m.state === 'ok' ? m.data.items : [];
  return (
    <section className="blk" aria-labelledby="matches-h">
      <h3 id="matches-h">{t('matches.title')}</h3>
      <p className="lead">{t('matches.lead')}</p>
      {m.state === 'error' && (
        <p className="inline-err" role="alert">
          {t('matches.loadError')}{' '}
          <button type="button" className="linkbtn" onClick={reload}>
            {t('common.retry')}
          </button>
        </p>
      )}
      {m.state === 'ok' && items.length === 0 && <p className="empty" data-testid="matches-empty">{t('matches.empty')}</p>}
      <div className={desktop ? 'games' : 'list'} data-testid="matches">
        {items.map((x) =>
          desktop ? (
            <div className="g" key={x.id} data-testid="match">
              <span className="lg">{x.league}</span>
              <span className="t">{x.title}</span>
              <span className="when">{kickoff(x.startsAt, lang)}</span>
            </div>
          ) : (
            <div className="li" key={x.id} data-testid="match">
              <div className="li-main">
                <span className="lg">{x.league}</span>
                <span className="t">{x.title}</span>
              </div>
              <span className="when">{kickoff(x.startsAt, lang)}</span>
            </div>
          ),
        )}
        <BtcCard btc={btc} desktop={desktop} />
      </div>
    </section>
  );
}

export const EXAMPLE = { win: 600, lose: 400, stake: 100 };

export function HowTo() {
  const { t } = useI18n();
  const ex = poolExample(EXAMPLE.win, EXAMPLE.lose, EXAMPLE.stake);
  const total = EXAMPLE.win + EXAMPLE.lose;
  return (
    <section className="blk" aria-labelledby="how-h">
      <h3 id="how-h">{t('how.title')}</h3>
      <p className="lead">{t('how.lead')}</p>
      <ol className="steps">
        {[1, 2, 3].map((i) => (
          <li className="st" key={i}>
            <h4>{t(`how.s${i}h`)}</h4>
            <p>{t(`how.s${i}p`)}</p>
          </li>
        ))}
      </ol>
      <div className="calc" data-testid="calc">
        {t('how.calc', {
          win: money(EXAMPLE.win),
          lose: money(EXAMPLE.lose),
          fee: money(ex.fee),
          share: money(ex.share),
          stake: money(EXAMPLE.stake),
          payout: money(ex.payout),
          total: money(total),
          back: money(total - ex.fee),
          rate: `${Math.round(ex.returnRate * 1000) / 10}%`,
        })}
      </div>
    </section>
  );
}

export function Deposit() {
  const { t } = useI18n();
  return (
    <section className="blk" aria-labelledby="dep-h">
      <h3 id="dep-h">{t('dep.title')}</h3>
      <p className="lead flat">{t('dep.body')}</p>
    </section>
  );
}

export function Faq() {
  const { t } = useI18n();
  return (
    <section className="blk" aria-labelledby="faq-h">
      <h3 id="faq-h">{t('faq.title')}</h3>
      {[1, 2, 3, 4, 5].map((i) => (
        <details key={i}>
          <summary>{t(`faq.q${i}`)}</summary>
          <p>{t(`faq.a${i}`)}</p>
        </details>
      ))}
    </section>
  );
}
