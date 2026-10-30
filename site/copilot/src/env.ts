export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  VERSION?: string;
  /** 密钥（Amos 在 Cloudflare 控制台填）：没填时 /v1/* 全部 404 */
  COPILOT_TOKEN?: string;
  GEMINI_API_KEY?: string;
  /** 网页后台（跟帖评论清单）的密码，≥ 16 个字符；没填时后台 404（C136） */
  COPILOT_PASSWORD?: string;
  GEMINI_MODEL?: string;
  /** 备用 AI（Workers AI 绑定，不用密钥）；没有绑定时只用 Gemini */
  AI?: unknown;
  /** 备用 AI 每天最多用多少 neurons（默认 8000，免费额度 10000） */
  WORKERS_AI_DAILY_NEURONS?: string;
  DAILY_REPLY_CAP?: string;
  /** 可选：只接受这个插件的来源（chrome-extension://<插件 ID>）；没填时接受任何 chrome-extension:// 来源 */
  ALLOWED_ORIGIN?: string;
}
