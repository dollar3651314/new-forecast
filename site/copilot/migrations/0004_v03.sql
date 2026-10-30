-- 副驾驶 0.3（Amos 2026-10-30）：跟帖评论清单记下打分依据；每个模型每天的用量和我们设的上限。记录一直保留，由 Amos 在后台自己删（D-4 选 B）。
ALTER TABLE queue ADD COLUMN reasons TEXT NOT NULL DEFAULT '[]';   -- 打分依据（JSON 数组，最多 3 条）
CREATE INDEX queue_at ON queue (at);
-- day：Gemini 按美国太平洋时间的日期（Google 半夜重置），Workers AI 按 UTC 日期（台湾早上 8 点重置）
CREATE TABLE model_usage (
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  req INTEGER NOT NULL DEFAULT 0,
  tok_in INTEGER NOT NULL DEFAULT 0,
  tok_out INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,          -- 最近一次的 HTTP 状态（0 = 超时或连不上）
  last_at INTEGER,
  PRIMARY KEY (day, model)
);
-- 后台"用量和限额"页设的值：cap:<模型名> → 每天上限（Gemini 按次数，Workers AI 按 neurons）
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
