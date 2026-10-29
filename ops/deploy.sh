#!/usr/bin/env bash
# 把本仓库源码同步到 N150-P 并重建容器。
# 需要：export N150P_PW='NAS 的 sudo 密码'
# 注意：部署前会自动备份现网目录；会覆盖远端 data/places.json，
# 容器重启后会由 Notion 单向同步自动刷新。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
NAS="${N150P_HOST:-caishen@192.168.8.253}"
RDIR="${CM_REMOTE_DIR:-/volume2/docker/chiang-mai-life}"
DOCKER=/usr/local/bin/docker
CT="${CM_CONTAINER:-chiang-mai-life-chiangmai-life-1}"
STAMP="$(date +%Y%m%d-%H%M%S)"
: "${N150P_PW:?导出 N150P_PW='NAS sudo 密码' 后再运行}"

cd "$ROOT"
tar czf - server.mjs Dockerfile docker-compose.yml package.json .dockerignore \
  scripts public config data docs README.md \
  | ssh -o BatchMode=yes -o ConnectTimeout=15 "$NAS" \
      'rm -rf /tmp/cm-src && mkdir -p /tmp/cm-src && tar xzf - -C /tmp/cm-src'

{
  printf '%s\n' "$N150P_PW"
  cat <<'REMOTE_SCRIPT'
set -e
RDIR="$1"
DOCKER="$2"
STAMP="$3"
mkdir -p /volume2/docker/chiang-mai-life-backups
if [ -d "$RDIR" ]; then
  tar --exclude='chiang-mai-life/media' -czf "/volume2/docker/chiang-mai-life-backups/pre-deploy-$STAMP.tgz" -C /volume2/docker chiang-mai-life
fi
mkdir -p "$RDIR" "$RDIR/runtime" "$RDIR/data" "$RDIR/media"
cp -R /tmp/cm-src/. "$RDIR"/
chmod 777 "$RDIR/runtime" "$RDIR/data" "$RDIR/media"
cd "$RDIR"
"$DOCKER" compose up -d --build
"$DOCKER" ps --filter name=chiang --format '{{.Names}} | {{.Status}}'
REMOTE_SCRIPT
} | ssh -o BatchMode=yes -o ConnectTimeout=15 "$NAS" \
  "sudo -S sh -s -- '$RDIR' '$DOCKER' '$STAMP'" \
  2>&1 | grep -vE 'WARNING|vulnerable|openssh|may need|^\*\*|Password'

echo "远端备份：/volume2/docker/chiang-mai-life-backups/pre-deploy-$STAMP.tgz"
