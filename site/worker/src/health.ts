/**
 * 健康检查 GET /api/health（C19、C28、C103）。
 * - status：UP（D1 能读）/ DOWN（D1 读不了，503）；environment、version（部署时传进来的提交号）。
 * - checks：db；board（行情：ok / stale 超过 30 分钟没更新 / down 从没取到过，每个源最近一次的结果）；
 *   mail（ok / not_configured：RESEND_API_KEY 没填 = 发信未开通，不是故障）；admin（ok / not_configured：ADMIN_PATH 没填或不合规、ADMIN_PASSWORD 没填或少于 16 个字符，任一）。
 *   "未开通"不影响 status。
 * **不返回任何密钥的值、长度或订阅数据。**
 */
import { boardHealth } from './board';
import { adminEnabled } from './admin';
import { environment, type Env } from './env';
import { json } from './http';
import { mailConfigured } from './mail';
import { log } from './util';

export async function health(env: Env, now: number): Promise<Response> {
  const base = { environment: environment(env), version: env.VERSION?.trim() || 'dev' };
  const config = {
    mail: mailConfigured(env) ? 'ok' : 'not_configured',
    admin: adminEnabled(env) ? 'ok' : 'not_configured',
  };
  try {
    const board = await boardHealth(env, now);
    return json({ status: 'UP', ...base, checks: { db: 'ok', board, ...config } });
  } catch (e) {
    log('health.db_error', { error: String((e as Error)?.message || e).slice(0, 200) });
    return json({ status: 'DOWN', ...base, checks: { db: 'down', ...config } }, 503);
  }
}
