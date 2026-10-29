#!/usr/bin/env bash
# 部署副驾驶中转服务（copilot/，agents C133）：CI 的 deploy job 在官网部署之后运行；可以重复运行。
#   bash site/scripts/deploy-copilot.sh staging      测试版 quickcome-copilot-staging
#   bash site/scripts/deploy-copilot.sh production   正式版 quickcome-copilot
# 步骤：D1 没有就建（ensure-d1.mjs --app copilot）→ 执行没执行过的迁移 → 部署（带提交号）→ 打印健康检查（不含密钥）。
# 没有 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 时打印"跳过"并成功（C103）。
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-}"
case "$TARGET" in
  staging) E="staging"; DB="quickcome-copilot-staging"; WORKER="quickcome-copilot-staging" ;;
  production) E=""; DB="quickcome-copilot"; WORKER="quickcome-copilot" ;;
  *) echo "用法：bash site/scripts/deploy-copilot.sh staging|production" >&2; exit 2 ;;
esac
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "· 跳过副驾驶部署：还没有 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID"
  exit 0
fi
export WRANGLER_SEND_METRICS=false
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
OUT="$(mktemp)"
trap 'rm -f copilot/wrangler.deploy.toml "$OUT"' EXIT
node scripts/ensure-d1.mjs --env "$TARGET" --app copilot
npx wrangler d1 migrations apply "$DB" --remote -c copilot/wrangler.deploy.toml --env="$E" || { echo "✗ 副驾驶 D1 迁移失败" >&2; exit 1; }
echo "✓ 副驾驶 D1 迁移"
npx wrangler deploy -c copilot/wrangler.deploy.toml --env="$E" --var "VERSION:$SHA" 2>&1 | tee "$OUT"
[ "${PIPESTATUS[0]}" = 0 ] || { echo "✗ 副驾驶部署失败" >&2; exit 1; }
echo "✓ 部署副驾驶 $TARGET（版本 $SHA）"
URL="$(grep -oE "https://${WORKER}\.[a-z0-9-]+\.workers\.dev" "$OUT" | head -1 || true)"
if [ -n "$URL" ]; then
  body="$(curl -s --max-time 10 "$URL/health" || true)"
  echo "· 健康检查（$URL/health，不含密钥）：$body"
  echo "  copilot = not_configured 表示还没填 COPILOT_TOKEN（≥ 24 个字符）或 GEMINI_API_KEY（/v1/* 全部 404，C102）"
fi
