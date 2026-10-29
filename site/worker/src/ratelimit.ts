/**
 * 按 IP 限次（固定窗口）：D1 表 rate_limit 按"用途 + IP 的 sha256 + 窗口开始时间"计数，一条 INSERT … ON CONFLICT … RETURNING
 * 完成"加一并读出"（D1 每条语句是原子的）。不存 IP 原文。过期的窗口由定时任务删掉。
 * 参照：forecast main 0caa740 cf/src/ratelimit.ts。
 */
export interface Limit {
  ok: boolean;
  /** 还要等多少秒（ok = false 时有意义） */
  retryAfter: number;
  count: number;
}

export async function hit(db: D1Database, bucket: string, key: string, limit: number, windowMs: number, now: number): Promise<Limit> {
  const start = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      'INSERT INTO rate_limit (bucket, key, window_start, count) VALUES (?1, ?2, ?3, 1) ' +
        'ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = count + 1 RETURNING count',
    )
    .bind(bucket, key, start)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  // 窗口结束的那一毫秒（start + windowMs）已经属于下一个窗口，所以至少等 1 秒（C106）
  const retryAfter = Math.max(1, Math.ceil((start + windowMs - now) / 1000));
  return { ok: count <= limit, retryAfter, count };
}

/** 删掉两小时以前的计数和登录失败记录（定时任务调用） */
export async function cleanup(db: D1Database, now: number, keepMs = 2 * 60 * 60 * 1000): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM rate_limit WHERE window_start < ?1').bind(now - keepMs),
    db.prepare('DELETE FROM auth_fail WHERE at < ?1').bind(now - keepMs),
    db.prepare('DELETE FROM auth_lock WHERE until < ?1').bind(now),
  ]);
}
