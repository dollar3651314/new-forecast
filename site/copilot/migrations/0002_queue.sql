-- 待回复清单和后台登录（agents C136，2026-10-30）。时间：at / until 是毫秒时间戳；day 是台湾日期。
-- 只存公开帖子的链接、作者、摘要和我们写的草稿；不存任何用户邮箱。30 天后删。
CREATE TABLE queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  product TEXT NOT NULL,
  platform TEXT NOT NULL,
  post_id TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  post_at INTEGER,               -- 帖子发布时间（估算，用来标"可能已过时"）
  score INTEGER,
  draft TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending / done / skip
  done_day TEXT,                -- 点"我回了"那天（台湾日期），算每天上限
  UNIQUE (platform, post_id)
);
CREATE INDEX queue_status ON queue (status, at);

-- 后台登录失败和锁定（做法同官网名单页：同一 IP 15 分钟错 5 次锁 15 分钟；全站 1 小时错 20 次锁 1 小时）
CREATE TABLE auth_fail (ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX auth_fail_at ON auth_fail (at);
CREATE TABLE auth_lock (scope TEXT PRIMARY KEY, until INTEGER NOT NULL);
