---
name: xhs-to-collection
description: 把小红书笔记链接（含详细地址 + 谷歌地图链接）自动转成清迈生活手册的一条收藏。当用户发来小红书链接并说「收藏到手册 / 加进手册 / 转成记录 / 记下这个地方」时使用。依赖 Hermes 现成的 agent-reach / xhs-archive skill 解析小红书正文，再调用手册的导入 API 落库。
---

# 小红书文案 → 手册收藏

## 用途

用户给一个小红书笔记链接（或文案），其中通常写了店名、详细地址，并附一个 Google 地图链接。
本 Skill 把它解析成结构化字段，写入清迈生活手册（cm.caishen.today）的收藏库。

## 前置条件

1. **解析能力**：优先用 Hermes 现成的 Skill：
   - `agent-reach`（MUST USE when 用户提到小红书/xhs 或分享 URL）——打开笔记链接、读取正文与图片。
   - `xhs-archive`——需要逐篇提取笔记详情/字幕时可用。
   - 若在当前环境不可用，退而用公开的 XHS 解析工具（如 XHS-Downloader）或让用户直接粘贴正文。
2. **导入令牌**：优先使用管理员后台「Bot 自动导入」里设置/轮换的 runtime 令牌；也可回退到服务端环境变量 `IMPORT_TOKEN`。两者都为空时导入端点关闭。后台令牌无需重新部署即可生效，且优先于环境变量。
3. **调用脚本**：`scripts/import-from-xhs.mjs`（本目录同级的上级 scripts/），需设置环境变量 `CM_BASE`（默认 https://cm.caishen.today）与 `IMPORT_TOKEN`（与后台/环境变量令牌一致）。

## 流程

### 第 1 步：解析小红书链接

用 `agent-reach` 打开链接，提取：
- `title`：店名 / 笔记标题（取最短且像店名的一段）
- `description`：正文描述（推荐菜、氛围、注意事项等）
- `address`：文案里写的详细地址
- `mapsUrl`：文案里的 Google 地图链接（`maps.app.goo.gl/...` 或 `google.com/maps/...`）
- `photos`：笔记图片 URL（可选，最多 6 张）
- `sourceUrl`：原始小红书链接（用于溯源）

字段缺失处理：
- 没有 `mapsUrl` → 若正文有「店名 + 地址」，让用户确认后再用谷歌搜索补全；**不要臆造地图链接**。
- 没有 `title` → 从正文首句或地图链接解析店名。

### 第 2 步：调用导入脚本

```bash
cd "/Users/elvis/Documents/New OpenCode Project/清迈生活手册PWA"
export IMPORT_TOKEN='<与服务端一致>'
node scripts/import-from-xhs.mjs \
  --title '店名' \
  --address '详细地址' \
  --maps 'https://maps.app.goo.gl/xxxx' \
  --desc '正文描述' \
  --category '咖啡' \
  --photos 'https://img1,https://img2' \
  --source 'https://www.xiaohongshu.com/explore/xxxx'
```

脚本会 `POST {CM_BASE}/api/bot/places`（旧端点 `/api/import/place` 兼容），用 Bearer token 或 `X-Bot-Token` 鉴权。返回 201 表示已收藏；409 表示重复（已收藏过），并附带已存在地点。建议传入 `--place-name`，短链接无法解析店名时尤其重要。

### 第 3 步：反馈

把结果告诉用户：店名、分类、是否成功、是否需要人工补充（如缺地图链接）。

## 安全与约定

- 只接受 Google 地图域名（maps.app.goo.gl / goo.gl / google.com），其它链接会被服务端拒绝。
- 图片只接受 http(s) URL；若防盗链导致图片不显示，可在网页后台替换为自有图片。
- 导入的记录 `imported: true`、`sharerName: '小红书导入'`，不奖励星星，不影响用户成长体系。
- 导入走的是 NAS 标准库（contributions），符合「NAS 为唯一数据源」约定。

## 相关文件

- 服务端导入端点：`server.mjs` 中 `POST /api/bot/places`（旧端点 `POST /api/import/place` 兼容）
- 导入脚本：`scripts/import-from-xhs.mjs`（支持 `--place-name` 与 `--external-id`）
- 鉴权令牌：管理后台「Bot 自动导入」设置的 runtime 令牌，或服务端 `IMPORT_TOKEN` 环境变量（后台优先）
