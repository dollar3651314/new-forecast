-- v1.1：焦点战的对战分成主队、客队两列（名单页分开填、批量导入）。迁移只往前走（Cloudflare 规范 K4）。
-- 兼容上一版代码：title 照旧写"主队 vs 客队"，旧代码读 title 不受影响；旧数据 home / away 为空串，显示时用 title（shared/rules.ts matchTitle）。
ALTER TABLE featured_matches ADD COLUMN home TEXT NOT NULL DEFAULT '';
ALTER TABLE featured_matches ADD COLUMN away TEXT NOT NULL DEFAULT '';
