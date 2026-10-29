#!/usr/bin/env bash
# 部署到 Cloudflare（Cloudflare 规范 K3）：CI 的 deploy job 在 ci-ok 通过后运行；可以重复运行。
#   bash site/scripts/deploy.sh staging      推到 staging 分支时：测试版 new-forecast-site-staging（workers.dev，整站密码门）
#   bash site/scripts/deploy.sh production   推到 main 分支时：正式版 new-forecast-site（workers.dev 备用地址 + Amos 以后绑的 www.quickcome.online）
# 步骤（每步一行 ✓ / ✗ / ·）：D1 没有就建（ensure-d1.mjs）→ 执行没执行过的 D1 迁移 → 部署（带提交号）→ 从输出里取 workers.dev 地址作为 M-12 备用网址
#   （第一次部署时还不知道地址，取到以后带上 BACKUP_URL 再部署一次）→ 打印健康检查的摘要（不含密钥，C98、C102）。
# 前提：已经 npm run build（site/dist）。需要 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID；没配时只打印"跳过"并成功退出（没配置不是故障，C103）。
# 参照：forecast main 0caa740 cf/scripts/deploy.sh。
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-}"
case "$TARGET" in
  staging) E="staging"; DB="new-forecast-site-staging"; WORKER="new-forecast-site-staging" ;;
  production) E=""; DB="new-forecast-site"; WORKER="new-forecast-site" ;;
  *) echo "用法：bash site/scripts/deploy.sh staging|production" >&2; exit 2 ;;
esac
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "· 跳过部署：GitHub Secrets 里还没有 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（填法见《项目地图》第 3 节）"
  exit 0
fi
export WRANGLER_SEND_METRICS=false
SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
OUT="$(mktemp)"
trap 'rm -f wrangler.deploy.toml "$OUT"' EXIT
[ -f dist/index.html ] || { echo "✗ 没有 site/dist：先运行 npm run build" >&2; exit 1; }

node scripts/ensure-d1.mjs --env "$TARGET"
npx wrangler d1 migrations apply "$DB" --remote -c wrangler.deploy.toml --env="$E" || { echo "✗ D1 迁移失败：看上面 wrangler 的错误（令牌要有 D1 Edit 权限）" >&2; exit 1; }
echo "✓ D1 迁移（只执行没执行过的）"

deploy() {
  npx wrangler deploy -c wrangler.deploy.toml --env="$E" --var "VERSION:$SHA" "$@" 2>&1 | tee "$OUT"
  return "${PIPESTATUS[0]}"
}
BACKUP="${SITE_BACKUP_URL:-}"
if [ -n "$BACKUP" ]; then deploy --var "BACKUP_URL:$BACKUP" || { echo "✗ 部署失败：看上面 wrangler 的错误（令牌要有 Workers Scripts Edit 权限）" >&2; exit 1; }
else deploy || { echo "✗ 部署失败：看上面 wrangler 的错误（令牌要有 Workers Scripts Edit 权限）" >&2; exit 1; }
fi
echo "✓ 部署 $TARGET（版本 $SHA）"
URL="$(grep -oE "https://${WORKER}\.[a-z0-9-]+\.workers\.dev" "$OUT" | head -1 || true)"
if [ -z "$BACKUP" ] && [ -n "$URL" ]; then
  deploy --var "BACKUP_URL:$URL" > /dev/null || { echo "✗ 带备用网址重新部署失败" >&2; exit 1; }
  echo "✓ 备用网址（M-12）：$URL"
elif [ -z "$URL" ]; then
  echo "· 输出里没有 workers.dev 地址：Cloudflare 控制台 Workers & Pages → Account details 里要先设一个 workers.dev 子域名（只需一次）"
fi

if [ -n "$URL" ]; then
  for _ in $(seq 1 6); do
    body="$(curl -s --max-time 10 "$URL/api/health" || true)"
    echo "$body" | grep -q "\"version\":\"$SHA\"" && break
    sleep 5
  done
  echo "· 健康检查（$URL/api/health，不含密钥）：$(echo "$body" | grep -oE '"(status|environment|version|mail|admin|gate)":"[^"]*"' | tr '\n' ' ')"
  echo "  默认关着的功能（C102）：mail = not_configured 表示还没填 RESEND_API_KEY（不发确认信）；admin = not_configured 表示还没填 ADMIN_PASSWORD（名单页 404$( [ "$TARGET" = staging ] && echo '，测试版整站 503' )）"
fi
