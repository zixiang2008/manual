# MausBot / 外部工具对接说明（v28+）

适用线上地址：`https://cm.caishen.today`（兼容域名 `https://cm.caishen2049.us`）。
对接目标是让 MausBot（或 Hermes Skill、小红书转收藏脚本）把解析出的地点直接写入手册的 NAS 标准库，写入后可在手册中搜索、打开、编辑。

---

## 1. 先拿到 Bot 令牌

**推荐：管理后台设置（无需重启服务）**

1. 用管理员账号登录手册网页。
2. 打开管理后台 →「Bot 自动导入」区块。
3. 点击「生成/轮换令牌」，系统生成 48 位随机令牌；也可手动填入 8–128 个字符的自定义令牌。
4. 复制页面上的**完整令牌**，交给 Bot 配置。页面只显示掩码，完整令牌仅在后台可见。

备用方式：在 NAS 的 `/volume2/docker/chiang-mai-life/.env` 写入 `IMPORT_TOKEN=<随机数>` 并重启容器。后台令牌优先级高于环境变量；停用后台令牌后会自动回退到环境变量。

**令牌只放在 Bot 服务端**，不要写进前端、网页链接或公开仓库。

---

## 2. 接口一览

| 用途 | 方法与路径 | 鉴权 |
| --- | --- | --- |
| 添加地点（主端点） | `POST /api/bot/places` | Bearer token 或 X-Bot-Token |
| 添加地点（兼容旧端点） | `POST /api/import/place` | 同上，建议新接入使用主端点 |
| 自检 | `GET /api/bot/status` | 同上 |

鉴权_header 二选一：

```
Authorization: Bearer <token>
X-Bot-Token: <token>
```

未配置令牌或令牌错误统一返回 `401 {"error":"Bot 令牌无效或未配置"}`。

自检成功示例：

```json
{ "ok": true, "endpoint": "/api/bot/places", "source": "runtime", "tokenMasked": "a1b2…wxyz" }
```

`source` 为 `runtime`（后台设置）、`env`（环境变量）或 `none`（未配置）。

---

## 3. 添加地点 `POST /api/bot/places`

请求体为 JSON（`Content-Type: application/json`，最大 2 MB）。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `mapsUrl` | 是 | Google Maps 地点链接，仅接受 Google Maps 域名白名单；支持 `/place/名称`、`@纬度,经度`、查询词，服务端会解析为检索字段 |
| `title` | 与 `description` 二选一 | 文案标题；会进入搜索索引 |
| `description` / `content` / `text` | 与 `title` 二选一 | 正文描述，写入详情 |
| `placeName` | 否 | 真实地点名（强烈建议提供，短链接无法解析时使用），写入 `name/title/searchText` |
| `address` | 否 | 地址文本，追加到详情并进入搜索索引 |
| `reasonTag` / `tag` | 否 | 推荐原因短标签（最多 60 字），缺省取标题或正文前 60 字 |
| `category` | 否 | 分类，缺省 `推荐` |
| `photos` | 否 | http(s) 图片 URL 数组，最多 6 张；非 http(s) 会被过滤 |
| `sourceUrl` / `url` | 否 | 原文链接（小红书笔记等），仅 http(s)，写入详情溯源 |
| `externalId` / `id` | 否 | Bot 侧唯一 ID，用于幂等去重（最多 120 字） |
| `botName` | 否 | 来源 Bot 名称，缺省 `MausBot` |

### 成功响应 `201`

```json
{
  "ok": true,
  "duplicate": false,
  "importId": "community-1a2b3c4d5e6f7890",
  "item": {
    "id": "community-1a2b3c4d5e6f7890",
    "title": "某家咖啡馆",
    "name": "某家咖啡馆",
    "maps": ["https://maps.app.goo.gl/..."],
    "category": "咖啡",
    "searchText": "某家咖啡馆 安静 手冲 ...",
    "imported": true,
    "provider": "bot"
  }
}
```

写入后地点立即进入 `/api/places` 列表与前端搜索；无需手动重建索引。

### 重复导入 `409`

同一个 `mapsUrl`（规范化后）或相同 `externalId` 已存在时返回：

```json
{ "error": "这个地点已经收藏，不会重复导入", "item": { "...": "已存在地点" } }
```

Bot 应把 409 视为成功幂等，不要报错重试。

### 其他错误

- `400`：`mapsUrl` 无效（非 Google Maps 域名）或缺少 `title`/`description`。
- `401`：令牌无效/未配置。
- 请求体超过 2 MB 会被拒绝。

---

## 4. curl 示例

```bash
curl -X POST https://cm.caishen.today/api/bot/places \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer 你的令牌' \
  -d '{
    "mapsUrl": "https://www.google.com/maps/place/Nimman+Soi+1/data=...",
    "placeName": "某家咖啡馆",
    "title": "宁曼路安静手冲咖啡",
    "description": "人均 120 泰铢，有插座，适合办公。",
    "address": "Nimmanahaeminda Road, Chiang Mai",
    "category": "咖啡",
    "reasonTag": "适合办公",
    "photos": ["https://example.com/photo1.jpg"],
    "sourceUrl": "https://www.xiaohongshu.com/explore/xxx",
    "externalId": "xhs-xxx"
  }'
```

项目内已有命令行脚本，适合 Hermes Skill 调用：

```bash
CM_BASE=https://cm.caishen.today IMPORT_TOKEN=你的令牌 \
  node scripts/import-from-xhs.mjs \
  --maps 'https://maps.app.goo.gl/...' \
  --title '宁曼路手冲咖啡' \
  --name '某家咖啡馆' \
  --desc '有插座，适合办公' \
  --category 咖啡 \
  --source 'https://www.xiaohongshu.com/explore/xxx' \
  --external-id 'xhs-xxx'
```

Skill 说明见 `skills/xhs-to-collection/SKILL.md`。

---

## 5. MausBot 侧处理流程（建议）

1. 收到小红书文案链接 → 用 Hermes `agent-reach` / `xhs-archive` 解析正文、图片和地址。
2. 从正文提取 Google Maps 链接（含 `maps.app.goo.gl` 短链）；没有则向用户追问。
3. 从 Maps 链接或正文提取地点名，填 `placeName`；短链无法解析时必须手工/模型补齐。
4. 组装上面的 JSON，带令牌 POST 到 `/api/bot/places`。
5. `201` → 记录 `importId`；`409` → 视为已收藏；`401` → 提醒管理员检查令牌；`400` → 检查链接与必填字段。
6. 用 `externalId`（如小红书笔记 ID）保证重复运行不会新增重复地点。

---

## 6. 后台可见内容（两位管理员均可查看）

管理后台 →「Bot 自动导入」区块显示：

- 接口地址、自检地址、启用状态、令牌来源、掩码令牌、完整令牌复制；
- 必填/可选字段说明与幂等策略；
- 最近 20 条导入记录；
- 「保存/轮换令牌」「停用 Bot」操作。

所有查看与配置操作会写入审计日志；普通用户访问 Bot 设置返回 `403`。

---

## 7. 排错

| 现象 | 原因与处理 |
| --- | --- |
| `401 Bot 令牌无效或未配置` | 后台生成令牌后再试；确认 header 拼写与令牌无多余空格 |
| `400 请提供有效的 Google 地图链接` | `mapsUrl` 必须是 Google Maps 域名，白名单外的链接会被拒绝 |
| `400 请提供文案标题或描述` | 至少提供 `title` 或 `description` |
| `409 已经收藏` | 幂等生效，无需处理；需要修改请用管理后台编辑该地点 |
| 导入成功但搜不到 | 用地点名而非分类词搜索；检查前端是否为 v28（页脚标识），必要时强制刷新清除 Service Worker 缓存 |
| 想停用 Bot | 后台点击「停用 Bot」，或清除 `IMPORT_TOKEN` 后重启容器 |
