#!/usr/bin/env bash
# 公网端到端验证（只读，不需要 NAS 权限）。
# 用法：CM_PIN=0409 ./ops/verify.sh
set -euo pipefail
BASE="${CM_BASE:-https://cm.caishen2049.us}"
USER="${CM_USER:-elvis}"
PIN="${CM_PIN:-}"

echo "== healthz =="
curl -s -m 20 "$BASE/healthz"; echo
echo "== index =="
curl -s -m 20 -o /dev/null -w "HTTP %{http_code}\n" "$BASE/"

if [ -n "$PIN" ]; then
  echo "== login =="
  curl -s -m 20 -c /tmp/cm.cookie -H 'Content-Type: application/json' \
    -d "{\"user\":\"$USER\",\"pin\":\"$PIN\"}" "$BASE/api/login"; echo
  echo "== places =="
  curl -s -m 20 -b /tmp/cm.cookie "$BASE/api/places" | python3 -c \
    "import sys,json;d=json.load(sys.stdin);print('fetchedAt:',d['source']['fetchedAt']);print('categories:',len(d['categories']));print('items:',len(d['items']))"
else
  echo "(跳过登录/数据检查：设置 CM_PIN=<PIN> 后重跑)"
fi
