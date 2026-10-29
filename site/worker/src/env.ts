/**
 * Worker 的绑定和变量。普通变量写在 site/wrangler.toml；密钥（RESEND_API_KEY、ADMIN_PASSWORD）由 Amos 在 Cloudflare 控制台
 * Settings → Variables and Secrets 填（Cloudflare 规范 K2），不经过 AI、不进仓库。wrangler.toml 里 keep_vars = true，部署不会冲掉控制台的值。
 * 名单见《项目索引》第 5 节。
 */
export interface Env {
  /** D1：订阅者、限次、登录失败、行情缓存、来源访问、焦点战（site/migrations/） */
  DB: D1Database;
  /** 静态资源（site/dist）：首页、专属页面、退订页、/about/；名单页的 console.html 只由 Worker 在 ADMIN_PATH 下取出来给 */
  ASSETS: Fetcher;
  /** production / staging / local / test：健康检查返回；不是 production 时页面顶部显示测试标识条、邮件标题加前缀、整站 noindex */
  ENVIRONMENT?: string;
  /** 部署时 CI 用 --var VERSION:<提交号> 传进来 */
  VERSION?: string;
  /** 邮件里链接用的站点地址，例如 https://www.quickcome.online；没填时用请求自己的地址 */
  PUBLIC_BASE_URL?: string;
  /** 发信地址，必须在 Resend 已验证的发信域名下 */
  MAIL_FROM?: string;
  /** M-12 备用网址（workers.dev 地址），页脚显示；部署脚本从 wrangler deploy 的输出里取，或 GitHub 变量 SITE_BACKUP_URL */
  BACKUP_URL?: string;
  /** 只在 ENVIRONMENT = local / test 时生效：把 Resend 的地址换成本机替身（端到端测试用），正式版和测试版忽略 */
  RESEND_API_URL?: string;
  // ---------- 下面是密钥（Secret），Amos 在控制台填 ----------
  /** Resend 的 API key（只给发信权限）；没填 = 发信未开通，不报错，健康检查 mail = not_configured */
  RESEND_API_KEY?: string;
  /** 名单页的地址（例如 /qc-ops-xxxxxxxx：以 / 开头、至少 12 个字符、只有字母数字和 -）；没填或不合规时名单页整体 404。不写进仓库（仓库公开） */
  ADMIN_PATH?: string;
  /** 名单页的唯一密码（没有账号）；少于 16 个字符或没填时名单页整体 404 */
  ADMIN_PASSWORD?: string;
}

export function environment(env: Env): string {
  return env.ENVIRONMENT?.trim() || 'production';
}
