/**
 * 这周的焦点战（M-2，需求单 v1.2：每周日挑 3～5 场，Amos 在名单页手动填或批量导入，不接体育数据接口）。
 * - 公开：GET /api/public/matches → 还没开赛或开赛不到 3 小时的，按开赛时间排序（shared/rules.ts matchVisible）。
 *   首页只显示联赛、对战（主队 vs 客队）、开赛时间，所以公开接口不返回备注。
 * - 名单页：GET / POST /api/admin/matches，PUT / DELETE /api/admin/matches/<id>，POST /api/admin/matches/import（登录后，admin.ts 先检查会话）。
 *   校验和规范化用 shared/rules.ts 的 validateMatch（和页面同一套，C108），一次返回全部字段的错误（C56）；最多 5 场。
 * - 批量导入 POST /api/admin/matches/import {items:[{league, home, away, startsAt, note}], replace}：
 *   每一行都检查完再返回（400，fields 的 field 写成 "行号.字段"，行号从 0 起）；全部正确才写入。
 *   replace = true 先清空现有场次；超过 5 场时按 pickMatches 只留开赛时间最近的 5 场（和页面预览同一个函数）。
 *   Excel / CSV 的解析在名单页浏览器里做（Worker 免费版每次请求只有 10ms CPU），这里只收整理好的 JSON。
 */
import { formatTaiwanTime, MATCH_LIMITS, matchTitle, matchVisible, pickMatches, validateMatch, type MatchClean } from '../../shared/rules';
import type { Env } from './env';
import { error, json, notFound, readJson } from './http';
import { iso, log } from './util';

interface MatchRow {
  id: number;
  league: string;
  title: string;
  home: string;
  away: string;
  starts_at: string;
  note: string;
}

const COLS = 'id, league, title, home, away, starts_at, note';

function out(r: MatchRow, now: number) {
  return {
    id: r.id,
    league: r.league,
    home: r.home,
    away: r.away,
    title: matchTitle(r),
    startsAt: r.starts_at,
    startsAtTw: formatTaiwanTime(r.starts_at),
    note: r.note,
    visible: matchVisible(r.starts_at, now),
  };
}

async function all(env: Env): Promise<MatchRow[]> {
  const r = await env.DB.prepare(`SELECT ${COLS} FROM featured_matches ORDER BY starts_at, id`).all<MatchRow>();
  return r.results ?? [];
}

export async function publicMatches(env: Env, now: number): Promise<Response> {
  const items = (await all(env)).filter((r) => matchVisible(r.starts_at, now)).map((r) => ({ id: r.id, league: r.league, title: matchTitle(r), startsAt: r.starts_at }));
  return json({ items }, 200, { 'Cache-Control': 'public, max-age=60' });
}

function invalid(errors: Record<string, string>): Response {
  return error(
    400,
    'VALIDATION_FAILED',
    'invalid match',
    Object.entries(errors).map(([field, code]) => ({ field, code })),
  );
}

function insert(env: Env, v: MatchClean, now: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO featured_matches (league, title, home, away, starts_at, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) RETURNING ${COLS}`,
  ).bind(v.league, v.title, v.home, v.away, v.startsAt, v.note, iso(now));
}

async function importMatches(req: Request, env: Env, now: number): Promise<Response> {
  const r = await readJson(req);
  if (!r.ok) return r.res;
  const raw = r.body.items;
  if (!Array.isArray(raw) || raw.length === 0) return error(400, 'VALIDATION_FAILED', 'no rows', [{ field: 'items', code: 'REQUIRED' }]);
  if (raw.length > 200) return error(400, 'VALIDATION_FAILED', 'too many rows', [{ field: 'items', code: 'TOO_LONG' }]);
  const fields: { field: string; code: string }[] = [];
  const clean: MatchClean[] = [];
  raw.forEach((x, i) => {
    const v = validateMatch(x && typeof x === 'object' ? (x as Record<string, unknown>) : {}, now);
    if (v.ok) clean.push(v.value);
    else for (const [f, code] of Object.entries(v.errors)) fields.push({ field: `${i}.${f}`, code: code! });
  });
  if (fields.length) return error(400, 'VALIDATION_FAILED', 'invalid rows', fields);
  const replace = r.body.replace === true;
  const existing = replace ? [] : (await all(env)).map((x) => ({ ...x, startsAt: x.starts_at }));
  const { keep, drop } = pickMatches(existing, clean, now);
  const keptNew = keep.filter((x): x is MatchClean => !('id' in x));
  const dropIds = drop.filter((x): x is MatchRow & { startsAt: string } => 'id' in x).map((x) => x.id);
  const stmts: D1PreparedStatement[] = [];
  if (replace) stmts.push(env.DB.prepare('DELETE FROM featured_matches'));
  for (const id of dropIds) stmts.push(env.DB.prepare('DELETE FROM featured_matches WHERE id = ?1').bind(id));
  for (const v of keptNew) stmts.push(insert(env, v, now));
  if (stmts.length) await env.DB.batch(stmts);
  log('admin.match_imported', { rows: clean.length, kept: keptNew.length, droppedExisting: dropIds.length, replace });
  return json({ imported: keptNew.length, skipped: clean.length - keptNew.length, removed: dropIds.length, total: keep.length, max: MATCH_LIMITS.max });
}

/** /api/admin/matches[/<id>|/import]（已登录） */
export async function adminMatches(req: Request, env: Env, path: string, now: number): Promise<Response> {
  if (path === '/api/admin/matches/import') return req.method === 'POST' ? importMatches(req, env, now) : error(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
  const m = /^\/api\/admin\/matches(?:\/(\d{1,9}))?$/.exec(path);
  if (!m) return notFound();
  const id = m[1] ? Number(m[1]) : null;
  if (id === null && req.method === 'GET') {
    const rows = await all(env);
    return json({ items: rows.map((r) => out(r, now)), max: MATCH_LIMITS.max });
  }
  if (id === null && req.method === 'POST') {
    const r = await readJson(req);
    if (!r.ok) return r.res;
    const v = validateMatch(r.body, now);
    if (!v.ok) return invalid(v.errors);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM featured_matches').first<{ n: number }>();
    if ((n?.n ?? 0) >= MATCH_LIMITS.max) return error(409, 'TOO_MANY_MATCHES', `at most ${MATCH_LIMITS.max} matches`);
    const row = await insert(env, v.value, now).first<MatchRow>();
    log('admin.match_created', { id: row!.id });
    return json(out(row!, now), 201);
  }
  if (id !== null && req.method === 'PUT') {
    const r = await readJson(req);
    if (!r.ok) return r.res;
    const v = validateMatch(r.body, now);
    if (!v.ok) return invalid(v.errors);
    const row = await env.DB.prepare(
      `UPDATE featured_matches SET league = ?1, title = ?2, home = ?3, away = ?4, starts_at = ?5, note = ?6, updated_at = ?7 WHERE id = ?8 RETURNING ${COLS}`,
    )
      .bind(v.value.league, v.value.title, v.value.home, v.value.away, v.value.startsAt, v.value.note, iso(now), id)
      .first<MatchRow>();
    if (!row) return error(404, 'MATCH_NOT_FOUND', 'match not found');
    log('admin.match_updated', { id });
    return json(out(row, now));
  }
  if (id !== null && req.method === 'DELETE') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== new URL(req.url).origin) return error(403, 'FORBIDDEN', 'cross-origin request');
    const d = await env.DB.prepare('DELETE FROM featured_matches WHERE id = ?1').bind(id).run();
    if (d.meta.changes !== 1) return error(404, 'MATCH_NOT_FOUND', 'match not found');
    log('admin.match_deleted', { id });
    return new Response(null, { status: 204 });
  }
  return error(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
}
