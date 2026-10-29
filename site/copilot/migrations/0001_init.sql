-- 副驾驶中转服务的表。迁移只往前走（Cloudflare 规范 K4）。时间：at 是毫秒时间戳；day 是台湾日期 YYYY-MM-DD。
-- 只存公开帖子的 ID、作者、文字摘要和操作记录，30 天后删除（技术方案第四节）；不存任何用户邮箱。
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  product TEXT NOT NULL,
  platform TEXT NOT NULL,
  post_id TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  score INTEGER,
  action TEXT NOT NULL,          -- scored / drafted / approve / skip / regenerate
  draft TEXT NOT NULL DEFAULT ''
);
CREATE INDEX events_day ON events (day, action);
CREATE INDEX events_at ON events (at);

-- 每分钟请求数（全站一个计数器，防止插件出错时刷爆 Gemini 免费额度）
CREATE TABLE rate (
  minute INTEGER PRIMARY KEY,
  n INTEGER NOT NULL
);
