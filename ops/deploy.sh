#!/usr/bin/env bash
# 把本仓库「代码」同步到 N150-P 并重建容器。
# 需要：export N150P_PW='NAS 的 sudo 密码'
#
# v27 起的数据权威约定（NAS 为唯一标准数据源）：
#   - 代码（server.mjs / scripts / public / config 模板 / 文档）：每次部署以本仓库为准，覆盖。
#   - 数据（data/ 下的 places.json 与各缓存、runtime/ 下的投稿/编辑/用户/审计）：
#     以 NAS 现网为准，本地副本仅用于「首次初始化」，绝不覆盖 NAS 已有数据。
#   - Notion 定时同步仍发生在 NAS 容器内，把 Notion 作为「导入源」汇入 NAS 标准库；
#     网页后台直接读写 NAS 标准库。两端都落在 NAS，本地 Mac 不再是数据源。
#   - 想把 NAS 标准库同步回本地，用 ops/pull-canonical.sh（只读拉取，不改 NAS）。
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

# 1) 代码包：每次部署都覆盖 NAS 上的同名代码文件
tar czf - server.mjs Dockerfile docker-compose.yml package.json .dockerignore \
  scripts public docs README.md CHANGELOG.md \
  | ssh -o BatchMode=yes -o ConnectTimeout=15 "$NAS" \
      'rm -rf /tmp/cm-code && mkdir -p /tmp/cm-code && tar xzf - -C /tmp/cm-code'

# 2) 种子数据包：仅当 NAS 上还没有标准库时用于初始化（绝不覆盖已有数据）
tar czf - config data \
  | ssh -o BatchMode=yes -o ConnectTimeout=15 "$NAS" \
      'rm -rf /tmp/cm-seed && mkdir -p /tmp/cm-seed && tar xzf - -C /tmp/cm-seed'

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
mkdir -p "$RDIR" "$RDIR/runtime" "$RDIR/data" "$RDIR/media" "$RDIR/config"

# 代码：始终以本次部署为准
cp -R /tmp/cm-code/. "$RDIR"/

# 数据：仅首次初始化；NAS 已有标准库则原样保留
if [ ! -f "$RDIR/data/places.json" ]; then
  cp -R /tmp/cm-seed/data/. "$RDIR/data"/
  echo "初始化 data/（NAS 尚无标准库）"
else
  echo "保留 NAS 现有 data/（标准库，未覆盖）"
fi
if [ -z "$(ls -A "$RDIR/config" 2>/dev/null)" ]; then
  cp -R /tmp/cm-seed/config/. "$RDIR/config"/
  echo "初始化 config/"
else
  echo "保留 NAS 现有 config/"
fi

chmod 777 "$RDIR/runtime" "$RDIR/data" "$RDIR/media"
cd "$RDIR"
"$DOCKER" compose up -d --build
"$DOCKER" ps --filter name=chiang --format '{{.Names}} | {{.Status}}'
REMOTE_SCRIPT
} | ssh -o BatchMode=yes -o ConnectTimeout=15 "$NAS" \
  "sudo -S sh -s -- '$RDIR' '$DOCKER' '$STAMP'" \
  2>&1 | grep -vE 'WARNING|vulnerable|openssh|may need|^\*\*|Password'

echo "远端备份：/volume2/docker/chiang-mai-life-backups/pre-deploy-$STAMP.tgz"
