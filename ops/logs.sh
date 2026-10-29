#!/usr/bin/env bash
# 查看容器日志（默认最后 60 行）。Notion 同步会打印点号和 "Synced N items in M categories"。
# 需要：export N150P_PW='NAS 的 sudo 密码'
set -euo pipefail
NAS="${N150P_HOST:-caishen@192.168.8.253}"
CT="${CM_CONTAINER:-chiang-mai-life-chiangmai-life-1}"
DOCKER=/usr/local/bin/docker
TAIL="${1:-60}"
: "${N150P_PW:?导出 N150P_PW='NAS sudo 密码' 后再运行}"

ssh -o BatchMode=yes -o ConnectTimeout=15 "$NAS" \
  "echo '$N150P_PW' | sudo -S $DOCKER logs --tail $TAIL $CT" \
  2>&1 | grep -vE 'WARNING|vulnerable|openssh|may need|^\*\*|Password'
