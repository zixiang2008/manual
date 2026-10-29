# Manual 清迈生活手册

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [ไทย](README.th.md) · [示例网站](https://cm.caishen.today)

## 项目介绍

Manual 把 Notion 中收集的生活地点变成安全的手机 PWA。它提供 PIN 登录、搜索、分类与附近筛选、泰国球体地图、列表模式、Google Maps 资料、朋友分享和管理员共同维护。示例网站需要账户，仓库不包含登录凭据。

## 主要功能

- 中、英、日、泰四语 PWA
- 4 位 PIN、scrypt 哈希、签名会话、限流和审计
- 可限次使用和停用的注册授权码
- Notion 定时单向同步，原子替换，失败保留上一版
- Google Maps 地址、营业时间、电话、官网、预订和照片
- 地球与列表双模式，200 米至 10 公里附近筛选
- 用户分享新地点，可选公开分享者姓名
- 每个新地点 5 颗星，30 颗星自动成为联合管理员
- 管理员与联合管理员可在线编辑展示资料

## 架构

```text
Notion 数据源 -> 定时单向同步 -> data/ 数据与 Google 缓存
                                            |
                                            v
Node.js 服务 <- runtime/ 用户、分享、照片、展示覆盖和审计
       |
       v
手机 PWA -> Cloudflare Tunnel -> HTTPS
```

Notion 是内容收集端。`runtime/` 是社区状态层，Notion 同步不会删除用户分享和管理员修改。网站不反写 Notion。

## 运行和配置

```bash
cp .env.example .env
npm install
npm start
npm run hash-pin -- 1234
```

需要 Node.js 22 或更高版本。环境变量包括 `SESSION_SECRET`、`PIN_USERS_JSON`、`NOTION_TOKEN`、`SYNC_INTERVAL_MINUTES`、`GOOGLE_MAPS_API_KEY` 和 `RUNTIME_DIR`。不要上传 PIN、API Key、Token、SSH 私钥或生产 `.env`。

## 同步、测试与部署

```bash
NOTION_TOKEN=your_token npm run sync:notion
npm test
docker compose up -d --build
curl http://127.0.0.1:3010/healthz
```

生产环境要持久化挂载 `runtime/` 并使用 HTTPS。主示例网址是 <https://cm.caishen.today>，旧链接 <https://cm.caishen2049.us> 继续可用。

## 安全原则

PIN 只保存加盐 scrypt 哈希，会话使用 HttpOnly 签名 Cookie，登录失败触发指数限流，修改请求校验来源，管理操作写入审计日志。
