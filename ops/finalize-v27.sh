#!/usr/bin/env bash
# v27 一键收尾：语法检查 → 测试 → git 提交推送 → 部署 → 线上验证。
# 任一步失败立即停止（set -e），不会带着未验证的代码上线。
#
# 用法：
#   bash ops/finalize-v27.sh
#
# 前置条件：
#   1. NAS 的 .env 已设置 IMPORT_TOKEN（若要启用小红书导入端点）：
#      在 NAS /volume2/docker/chiang-mai-life/.env 追加一行 IMPORT_TOKEN=<随机数>
#      生成随机数：openssl rand -hex 24
#   2. 本机已配置 git 与 SSH 公钥登录 NAS。
#   3. 确认要部署（脚本会先做本地验证，最后才动线上）。
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
  git commit -m "feat(v27): NAS canonical data, admin edit freedom, XHS-to-collection import

- NAS becomes the single source of truth; deploy no longer overwrites NAS data
- Notion sync changed from overwrite to incremental import
- Lift admin edit limits while keeping security gates
- Add POST /api/import/place + xhs-to-collection skill + import script"
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
echo '--- 首页版本号（应为 ?v=27）---'
curl -s -m 20 https://cm.caishen.today/ | grep -o '?v=[0-9]*' | sort -u
echo '--- healthz（应为 {"ok":true}）---'
curl -s -m 20 https://cm.caishen.today/healthz; echo
echo '--- 兼容域名 healthz ---'
curl -s -m 20 https://cm.caishen2049.us/healthz; echo

printf '\n===== 收尾完成 =====\n'
echo '提示：小红书导入端点需在 NAS .env 设置 IMPORT_TOKEN 后才会启用。'
echo '      设置方法：在 NAS /volume2/docker/chiang-mai-life/.env 追加一行：'
echo '        IMPORT_TOKEN=<用 openssl rand -hex 24 生成的随机数>'
echo '      然后重新部署（bash ops/deploy.sh）或重启容器使其生效。'
