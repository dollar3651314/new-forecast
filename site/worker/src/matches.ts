/**
 * 这周的焦点战（M-2，需求单 v1.2：每周日的日历任务挑 3～5 场，Amos 在名单页手动填，不接体育数据接口）。
 * - 公开：GET /api/public/matches → 还没开赛或开赛不到 3 小时的，按开赛时间排序（shared/rules.ts matchVisible）。
 * - 名单页：GET / POST /api/admin/matches，PUT / DELETE /api/admin/matches/<id>（登录后，admin.ts 先检查会话）。
 *   校验和规范化用 shared/rules.ts 的 validateMatch（和页面同一套，C108），一次返回全部字段的错误（C56）；最多 5 场。
 */
import { formatTaiwanTime, MATCH_LIMITS, matchVisible, validateMatch } from '../../shared/rules';
import type { Env } from './env';
import { error, json, notFound, readJson } from './http';
import { iso, log } from './util';

interface MatchRow {
  id: number;
  league: string;
  title: string;
  starts_at: string;
  note: string;
}

function out(r: MatchRow, now: number) {
  return { id: r.id, league: r.league, title: r.title, startsAt: r.starts_at, startsAtTw: formatTaiwanTime(r.starts_at), note: r.note, visible: matchVisible(r.starts_at, now) };
}

async function all(env: Env): Promise<MatchRow[]> {
  const r = await env.DB.prepare('SELECT id, league, title, starts_at, note FROM featured_matches ORDER BY starts_at, id').all<MatchRow>();
  return r.results ?? [];
}

export async function publicMatches(env: Env, now: number): Promise<Response> {
  const items = (await all(env)).filter((r) => matchVisible(r.starts_at, now)).map((r) => out(r, now));
  return json({ items: items.map(({ visible: _v, ...x }) => x) }, 200, { 'Cache-Control': 'public, max-age=60' });
}

function invalid(errors: Record<string, string>): Response {
  return error(
    400,
    'VALIDATION_FAILED',
    'invalid match',
    Object.entries(errors).map(([field, code]) => ({ field, code })),
  );
}

/** /api/admin/matches[/<id>]（已登录） */
export async function adminMatches(req: Request, env: Env, path: string, now: number): Promise<Response> {
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
    const row = await env.DB.prepare(
      'INSERT INTO featured_matches (league, title, starts_at, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING id, league, title, starts_at, note',
    )
      .bind(v.value.league, v.value.title, v.value.startsAt, v.value.note, iso(now))
      .first<MatchRow>();
    log('admin.match_created', { id: row!.id });
    return json(out(row!, now), 201);
  }
  if (id !== null && req.method === 'PUT') {
    const r = await readJson(req);
    if (!r.ok) return r.res;
    const v = validateMatch(r.body, now);
    if (!v.ok) return invalid(v.errors);
    const row = await env.DB.prepare(
      'UPDATE featured_matches SET league = ?1, title = ?2, starts_at = ?3, note = ?4, updated_at = ?5 WHERE id = ?6 RETURNING id, league, title, starts_at, note',
    )
      .bind(v.value.league, v.value.title, v.value.startsAt, v.value.note, iso(now), id)
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
