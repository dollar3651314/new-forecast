-- 备用 AI（Workers AI，2026-10-30 Amos 选 A）：每天用了多少 neurons（day 是 UTC 日期，和 Cloudflare 免费额度重置时间一致），30 天后删。
CREATE TABLE ai_usage (
  day TEXT PRIMARY KEY,
  neurons REAL NOT NULL DEFAULT 0
);
-- 待回复清单里记下草稿是哪个 AI 写的（gemini / workers-ai），后台给备用 AI 写的加标记
ALTER TABLE queue ADD COLUMN engine TEXT NOT NULL DEFAULT 'gemini';
