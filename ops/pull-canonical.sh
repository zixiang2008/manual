#!/usr/bin/env bash
# 从 NAS「拉取」标准数据源到本地，使本地 data/ 与 runtime/ 快照与 NAS 对齐。
# 用途：本地开发、排查、备份。只读 NAS，不修改 NAS 任何文件。
# 注意：这会用 NAS 的数据覆盖本地 data/ 与 runtime/；本地如有未提交的手工改动请先备份。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
NAS="${N150P_HOST:-caishen@192.168.8.253}"
RDIR="${CM_REMOTE_DIR:-/volume2/docker/chiang-mai-life}"
STAMP="$(date +%Y%m%d-%H%M%S)"

cd "$ROOT"
# 先备份本地副本
if [ -d data ]; then cp -R data "data.local-backup-$STAMP"; echo "本地 data 已备份到 data.local-backup-$STAMP"; fi
if [ -d runtime ]; then cp -R runtime "runtime.local-backup-$STAMP"; echo "本地 runtime 已备份到 runtime.local-backup-$STAMP"; fi

mkdir -p data runtime
echo "从 NAS 拉取标准库（$NAS:$RDIR）..."
ssh -o BatchMode=yes -o ConnectTimeout=15 "$NAS" \
  "tar czf - -C '$RDIR' data runtime 2>/dev/null || tar czf - -C '$RDIR' data" \
  | tar xzf - -C "$ROOT"

echo "完成。本地 data/（Notion 导入快照 + 缓存）与 runtime/（投稿/编辑/用户）已与 NAS 对齐。"
echo "提示：data.local-backup-$STAMP 与 runtime.local-backup-$STAMP 为覆盖前备份，确认无误后可手动删除。"
