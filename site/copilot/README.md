# 副驾驶（Quick Come 社媒回复助手）

规则：agents C133（营销团队手册 A8）；技术方案：agents `营销团队/副驾驶/技术方案.md`。

| 目录 | 是什么 |
|---|---|
| `src/`、`migrations/`、`wrangler.toml` | 中转服务（Cloudflare Worker `quickcome-copilot`，测试版 `quickcome-copilot-staging`，各自一个 D1） |
| `rules/` | 给 AI 的规则（只放发帖准则；来源在 agents，改了走 PR 同步） |
| `extension/` | Chrome 插件（Manifest V3，侧边栏 + X / Threads 读取适配器），开发者模式加载 |

测试：`cd site && npx vitest run --project copilot`（中转服务、读取适配器、插件权限）。部署：CI 在官网部署之后运行 `scripts/deploy-copilot.sh`。

## 一、开通中转服务（Amos，约 5 分钟）
1. 推到 main 以后，Cloudflare 里会多出 Worker `quickcome-copilot`。打开它 → Settings → Variables and Secrets，加两个 **Secret**：
   - `GEMINI_API_KEY`：在 Google AI Studio（aistudio.google.com）→ Get API key → 为副驾驶**单独建一个** Key。
   - `COPILOT_TOKEN`：自己编一串至少 24 个字符的随机字母数字（只给插件用）。
2. 打开 `https://quickcome-copilot.<你的子域>.workers.dev/health`，看到 `"copilot":"ok"` 就开通了（没填时是 `not_configured`，插件的请求一律 404）。
3. **跟帖评论清单（网页后台，原"待回复清单"；还有"用量和限额"页，可设每个模型每天的上限）**：再加一个 Secret `COPILOT_PASSWORD`（自己编，至少 16 个字符，和 `COPILOT_TOKEN` 不同）。打开 `https://quickcome-copilot.<你的子域>.workers.dev/` 用这个密码登录；手机也能打开。
4. 备用 AI（Workers AI）不用填任何东西：部署时自动绑定官网的 Cloudflare 账号，Gemini 都用不了时才用，每天用到 8,000 neurons 就停（免费额度 10,000）。插件设置页"测试 AI"最后一行就是它。
5. 可选：插件装好后，把插件 ID 填成变量 `ALLOWED_ORIGIN = chrome-extension://<插件 ID>`，只让你这一个插件连。

## 二、安装插件（Amos，约 3 分钟）
1. 下载这个仓库的 `site/copilot/extension/` 文件夹（GitHub 页面右上角 Code → Download ZIP，解压后找到这个文件夹）。
2. Chrome 打开 `chrome://extensions` → 右上角打开"开发者模式" → "加载已解压的扩展程序" → 选这个文件夹。
3. 点工具栏的拼图图标，把"Quick Come 副驾驶"固定出来；点它打开侧边栏 → "设置"：填中转服务地址（上面第 2 步的网址，不带 /health）和 `COPILOT_TOKEN` → "保存并测试连接"，看到"连接成功"。
4. 打开 x.com 或 threads.com 首页往下滑，值得回的帖子下面会出现绿色标记。

插件更新：下载新的文件夹覆盖旧的，到 `chrome://extensions` 点插件上的刷新按钮。
