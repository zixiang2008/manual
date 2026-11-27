#!/usr/bin/env bash
# v28 一键收尾：语法检查 → 测试 → git 提交推送 → 部署 → 线上验证。
# 任一步失败立即停止（set -e），不会带着未验证的代码上线。
#
# 用法：
#   bash ops/finalize-v28.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

step() { printf '\n===== [%s] %s =====\n' "$1" "$2"; }

step 1/6 '语法检查'
node --check server.mjs
node --check public/app.js
node --check public/sw.js
node --check scripts/sync-notion.mjs
node --check scripts/import-from-xhs.mjs
bash -n ops/deploy.sh
bash -n ops/pull-canonical.sh
echo '语法检查通过'

step 2/6 '运行测试'
npm test

step 3/6 'git 提交并推送'
git add -A
if git diff --cached --quiet; then
  echo '没有待提交的改动，跳过 commit'
else
  git commit -m "fix(v28): shared places searchable + MausBot import API

- use real place names as primary search fields for community and imported places
- add optional place-name field on share form and clear search after sharing
- parse Google Maps place name, coordinates and query into searchText/location
- serve live status for community places instead of 404
- add POST /api/bot/places (legacy /api/import/place kept) with token auth
- add GET /api/bot/status and admin bot settings panel for both admins
- support runtime token rotation, idempotent imports and audit logging"
fi
git push origin main

step 4/6 '准备 NAS sudo 凭据'
if [ -n "${N150P_PW:-}" ]; then
  echo '使用已设置的 N150P_PW'
elif [ -f "/Users/elvis/Documents/New OpenCode Project/AGENTS.md" ]; then
  export N150P_PW="$(sed -n '365s/.*sudo 密码 `\([^`]*\)`.*/\1/p' '/Users/elvis/Documents/New OpenCode Project/AGENTS.md')"
  [ -n "$N150P_PW" ] || { echo '未能从 AGENTS.md 读取 sudo 密码，请手动 export N150P_PW'; exit 1; }
  echo '已从 AGENTS.md 读取 sudo 密码'
else
  echo '请手动 export N150P_PW 后重试'; exit 1
fi

step 5/6 '部署到 NAS（脚本内会自动备份现网）'
bash ops/deploy.sh

step 6/6 '线上验证'
echo '--- 首页资源版本号（应为 ?v=28）---'
curl -s -m 20 https://cm.caishen.today/ | grep -o '?v=[0-9]*' | sort -u
echo '--- 页脚版本标识 ---'
curl -s -m 20 https://cm.caishen.today/ | grep -o 'v28 · [^<]*' | head -1
echo '--- healthz（应为 {"ok":true}）---'
curl -s -m 20 https://cm.caishen.today/healthz; echo
echo '--- 兼容域名 healthz ---'
curl -s -m 20 https://cm.caishen2049.us/healthz; echo
echo '--- Bot 自检端点 HTTP 状态（未带令牌应为 401，说明端点已上线）---'
curl -s -o /dev/null -w '%{http_code}\n' -m 20 https://cm.caishen.today/api/bot/status

printf '\n===== 收尾完成 =====\n'
echo '提示：Bot 令牌请在管理后台「Bot 自动导入」区块设置/轮换，无需重启服务。'
