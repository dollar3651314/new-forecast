-- Quick Come 官网 / 等候页 v1 的 D1 表。迁移只往前走（Cloudflare 规范 K4）：以后改表另加 0002…，并兼容上一版代码。
-- 时间：文字列是 UTC 的 ISO 字符串（毫秒，结尾 Z，例如 2026-10-29T08:00:00.000Z），按字符串比较就是按时间比较；
--       名为 at / until / window_start 的整数列是毫秒时间戳。
-- 参照：forecast main 0caa740 cf/migrations/0001_init.sql（waitlist、rate_limit、board_cache、source_status、visit_daily），按 v1 需求改写。

-- 1. 订阅者（留邮箱）。双重确认：PENDING 待确认 → CONFIRMED 已确认；任何时候都能退订（UNSUBSCRIBED）。同一邮箱一行（小写）。
--    确认链接 7 天有效（confirm_sent_at 起算）；同一邮箱两封确认邮件至少隔 10 分钟、最多 5 封（confirm_sends）；IP 只存 sha256。
--    beta：勾了"愿意参加内测"（M-6）。channel：订阅时的来源归类——ref 是一个已确认订阅者的邀请码时为 'invite'，否则是 src（没有为空串），名单页按它算转化（M-9）。
--    invite_code：自己的 6 位邀请码（M-10，别人用 ?ref=码 进来并确认算一次邀请）；invite_key：查看"邀请了几个人"的私密密钥（32 位十六进制，和邀请码不同）。
--    两个都在第一次留邮箱时生成，但邀请码只在确认以后才显示给本人（确认页、邀请查看页）。
CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL CHECK (lang IN ('en', 'zh-CN', 'zh-TW')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'UNSUBSCRIBED')),
  beta INTEGER NOT NULL DEFAULT 0 CHECK (beta IN (0, 1)),
  confirm_token TEXT NOT NULL UNIQUE,
  confirm_sent_at TEXT NOT NULL,
  confirm_sends INTEGER NOT NULL DEFAULT 1,
  unsub_token TEXT NOT NULL UNIQUE,
  invite_code TEXT NOT NULL UNIQUE,
  invite_key TEXT NOT NULL UNIQUE,
  src TEXT,
  cmp TEXT,
  ref TEXT,
  channel TEXT NOT NULL DEFAULT '',
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_subscribers_status ON subscribers (status, id);
CREATE INDEX idx_subscribers_ref ON subscribers (ref);
CREATE INDEX idx_subscribers_confirmed ON subscribers (confirmed_at);

-- 2. 按 IP 限次（固定窗口；key 是 IP 的 sha256）。定时任务删两小时以前的窗口。
CREATE TABLE rate_limit (
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, key, window_start)
);

-- 3. 名单页 / 测试版密码门的登录失败（只记 IP 的 sha256 和时间，不记输入的内容）。同一 IP 15 分钟错 5 次、全站 1 小时错 20 次就加锁。
CREATE TABLE auth_fail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_auth_fail_ip ON auth_fail (ip_hash, at);
CREATE INDEX idx_auth_fail_at ON auth_fail (at);

-- 4. 登录锁：scope = 'ip:<IP 的 sha256>'（锁 15 分钟）或 'global'（锁 1 小时）；until 之前（不含 until 那一毫秒）都算锁着。
CREATE TABLE auth_lock (
  scope TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);

-- 5. 看板的行情缓存（只有一行，id = 1）：定时任务写，页面只读这一行。
CREATE TABLE board_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 6. 每个行情源最近一次的结果（健康检查用：部署后看 Cloudflare 出口能不能访问 OKX、币安）。
CREATE TABLE source_status (
  source TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  last_ok_at TEXT
);

-- 7. 带来源的访问，按天（UTC）+ channel + cmp 计数（M-9 的"访问 → 确认"转化；不记 IP、设备号）。channel 的含义同 subscribers.channel。
CREATE TABLE visit_daily (
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  cmp TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, channel, cmp)
);

-- 8. 这周的焦点战（M-2，名单页手动填，最多 5 场）。starts_at 是 UTC ISO；首页只显示开赛不到 3 小时的。
CREATE TABLE featured_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league TEXT NOT NULL,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_featured_matches_start ON featured_matches (starts_at);
