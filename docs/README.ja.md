# Manual チェンマイ生活ガイド

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [ไทย](README.th.md) · [デモ](https://cm.caishen.today)

## 概要

Manual は、Notion で収集したチェンマイの生活情報を安全なモバイル PWA として提供するプロジェクトです。PIN ログイン、検索、カテゴリと距離の絞り込み、タイの球体地図、リスト表示、Google Maps 情報、コミュニティ投稿、管理者の共同編集を統合します。デモにはアカウントが必要で、認証情報は公開していません。

## 主な機能

- 中国語、英語、日本語、タイ語対応
- 4桁 PIN、scrypt ハッシュ、署名セッション、レート制限、監査ログ
- 回数制限と無効化が可能な招待コード
- Notion からの定期的な一方向同期
- Google Maps の住所、営業時間、電話、サイト、予約、写真
- 球体とリスト表示、200 m から 10 km の近隣検索
- 投稿ごとに5スター、30スターで共同管理者へ自動昇格
- 管理者と共同管理者によるオンライン編集

## アーキテクチャ

```text
Notion -> 定期的な一方向同期 -> data/ + Google Maps キャッシュ
                                      |
                                      v
Node.js サービス <- runtime/ ユーザー、投稿、写真、表示上書き、監査
       |
       v
モバイル PWA -> Cloudflare Tunnel -> HTTPS
```

Notion は収集元です。コミュニティの状態は `runtime/` に保存されるため、Notion 同期で消えません。ウェブサイトから Notion への書き戻しは行いません。

## 実行方法

Node.js 22 以上が必要です。

```bash
cp .env.example .env
npm install
npm start
npm run hash-pin -- 1234
```

主な環境変数は `SESSION_SECRET`、`PIN_USERS_JSON`、`NOTION_TOKEN`、`SYNC_INTERVAL_MINUTES`、`GOOGLE_MAPS_API_KEY`、`RUNTIME_DIR` です。PIN、API キー、トークン、SSH 秘密鍵、本番 `.env` はコミットしないでください。

## 同期、テスト、Docker

```bash
NOTION_TOKEN=your_token npm run sync:notion
npm test
docker compose up -d --build
curl http://127.0.0.1:3010/healthz
```

本番環境では `runtime/` を永続化し、HTTPS を使ってください。デモは <https://cm.caishen.today> です。

## セキュリティ

PIN はソルト付き scrypt ハッシュだけを保存します。セッションは HttpOnly 署名 Cookie、失敗ログインは指数的に制限され、管理操作は監査ログに記録されます。
