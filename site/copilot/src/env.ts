export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  VERSION?: string;
  /** 密钥（Amos 在 Cloudflare 控制台填）：没填时 /v1/* 全部 404 */
  COPILOT_TOKEN?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  DAILY_REPLY_CAP?: string;
  /** 可选：只接受这个插件的来源（chrome-extension://<插件 ID>）；没填时接受任何 chrome-extension:// 来源 */
  ALLOWED_ORIGIN?: string;
}
