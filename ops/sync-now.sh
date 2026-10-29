#!/usr/bin/env bash
# 重启容器，触发一次 Notion 同步（启动即同步一次）。
# 需要：export N150P_PW='NAS 的 sudo 密码'
set -euo pipefail
NAS="${N150P_HOST:-caishen@192.168.8.253}"
RDIR="${CM_REMOTE_DIR:-/volume2/docker/chiang-mai-life}"
DOCKER=/usr/local/bin/docker
: "${N150P_PW:?导出 N150P_PW='NAS sudo 密码' 后再运行}"

ssh -o BatchMode=yes -o ConnectTimeout=15 "$NAS" \
  "cd '$RDIR' && echo '$N150P_PW' | sudo -S $DOCKER compose restart" \
  2>&1 | grep -vE 'WARNING|vulnerable|openssh|may need|^\*\*|Password'
echo "已重启。约 2 分钟后用 ops/logs.sh 查看 'Synced N items in M categories'。"
