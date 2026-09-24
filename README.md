# Costco Product Stock Watcher v2

以 Cloudflare Worker 執行的 Costco 台灣商品庫存監控工具。使用者可直接透過 Telegram 新增與管理商品；系統每五分鐘檢查一次 Costco 商品 API，只在可信的狀態改變時通知。

> v2 目前位於 `feat/worker-v2`，尚未部署到正式環境。舊版 Python/Playwright 腳本保留在 `src/monitor.py`，供回溯使用。

## v2 改善重點

- Telegram-first：直接貼 Costco 商品網址即可加入監控。
- D1 持久化商品、檢查歷史、通知狀態及執行鎖。
- 從既有 `COSTCO_KV` 的 `products` key 自動匯入商品。
- 明確區分 `in_stock`、`out_of_stock`、`unknown`、`blocked`、`not_found`、`error`。
- 首次建立基準不推播；只通知已確認的「缺貨 → 有貨」。
- 使用 notification outbox；Telegram 暫時失敗時會保留並重試通知。
- 連續錯誤達閾值才告警，恢復後另行通知。
- Cron 執行鎖避免兩輪監控重疊。
- 公開 `/health` 不洩漏 watchlist；管理端點需要 Bearer token。
- 結構化日誌、Cloudflare Workers Logs 與本機 Worker/D1 測試。

## 架構

```text
Telegram webhook ──► command handlers ──► D1 watchlist
                                            │
Cloudflare Cron ──► monitor service ──► Costco REST API
                                            │
                                     observation + state
                                            │
                              D1 history + notification outbox
                                            │
                                            ▼
                                      Telegram Bot API
```

## Telegram 操作

- 直接貼上 Costco 台灣商品網址：新增或恢復監控。
- `/watchlist`：顯示監控商品卡片。
- `/check [商品編號]`：檢查全部或單一商品。
- `/pause 商品編號`：暫停。
- `/resume 商品編號`：恢復。
- `/remove 商品編號`：確認後封存，保留歷史。
- `/status`：查看服務狀態。
- `/help`：查看說明。

舊版 `/trackcc help|list|add|remove|check` 指令仍保留相容性。

## 開發環境

需求：Node.js 22 以上、pnpm；只有建立資源或部署時才需要 Cloudflare 帳號。

```bash
pnpm install
pnpm cf-typegen
pnpm check
pnpm test
pnpm deploy:dry-run
```

建立本機 secrets：

```bash
cp .dev.vars.example .dev.vars
```

請在 `.dev.vars` 填入 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TG_WEBHOOK_SECRET`、`ADMIN_TOKEN`，然後執行：

```bash
pnpm db:migrate:local
pnpm dev
```

不要把 `.dev.vars` commit 到 Git。

## Cloudflare 資源

v2 使用 Worker、D1、既有 `COSTCO_KV`、五分鐘 Cron Trigger 與 Workers Logs。KV 只用於首次匯入舊 watchlist。

`wrangler.jsonc` 目前的 D1 database id 是本機 placeholder。部署前必須先建立正式 D1：

```bash
pnpm exec wrangler d1 create costco-stock-watcher-v2 --location=apac
```

將回傳的 `database_id` 填入 `wrangler.jsonc`，然後：

```bash
pnpm exec wrangler d1 migrations apply costco-stock-watcher-v2 --remote
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_CHAT_ID
pnpm exec wrangler secret put TG_WEBHOOK_SECRET
pnpm exec wrangler secret put ADMIN_TOKEN
pnpm exec wrangler deploy --dry-run
pnpm exec wrangler deploy
```

不要把 secret 當成命令參數、寫入 `wrangler.jsonc` 或 commit 到 Git。

## HTTP routes

| Route | Access | Purpose |
|---|---|---|
| `GET /` | Public | 服務名稱與安全的 route 摘要 |
| `GET /health` | Public | 健康狀態與商品數量，不含 watchlist 明細 |
| `POST /tg-webhook/{secret}` | Webhook secret + chat allowlist | Telegram webhook |
| `GET /internal/status` | Bearer `ADMIN_TOKEN` | 完整狀態 |
| `POST /internal/check` | Bearer `ADMIN_TOKEN` | 手動執行檢查 |

## 狀態判定

有貨必須同時滿足：

- Costco API 回傳有效的商品 identity。
- `stockLevelStatus` 為 `inStock`。
- 商品為 `purchasable`。
- 如果 API 有提供 `stockLevel`，數量必須大於 0。

`stockLevelStatus=outOfStock` 或 `stockLevel=0` 才判定缺貨。資料不足時使用 `unknown` 或 `not_found`，不把錯誤當成缺貨。

## 從現有 Worker 遷移

目前正式 Worker `costco-ims` 的盤點結果：

- 有三個 secret：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、`TG_WEBHOOK_SECRET`。
- 綁定既有 KV namespace `COSTCO_KV`。
- Workers Logs 已開啟。
- 相容性日期為 `2026-05-12`。
- **未設定 Cron Trigger**；這是舊資料停在 2026-05-12 的主要原因。
- 目前 KV watchlist 有五件商品。
- `/status` 與 `/trackcc/list` 目前公開顯示完整 watchlist；v2 已改成預設不公開。

建議切換順序：

1. 保留 `costco-ims` 不動。
2. 建立 D1 與 staging Worker `costco-stock-watcher-v2`。
3. 設定相同 Telegram secrets，但先不要切換 webhook。
4. 讓 v2 從 KV 匯入五件商品，執行 dry-run 並比對結果。
5. 觀察 24–48 小時的 scheduled checks、D1 history 與 logs。
6. 切換 Telegram webhook 到 v2。
7. 確認補貨去重、錯誤告警與恢復通知後，再停用舊 Worker。

## 專案結構

```text
src/
├── index.ts          # Worker routes 與 scheduled handler
├── domain.ts         # 狀態模型與通知決策
├── costco.ts         # Costco API adapter
├── repository.ts     # D1 repository、KV importer、outbox
├── monitor.ts        # 排程、併發、鎖與通知派送
├── notifications.ts  # 狀態改變通知
├── telegram.ts       # Telegram commands/callbacks
└── env.ts            # generated Env 上的 secret 型別
migrations/           # D1 schema
test/                 # Worker runtime、domain、parser、D1 測試
src/monitor.py        # v1 legacy script
```

## 使用限制

本專案僅供個人用途。請維持合理的檢查頻率，尊重 Costco 網站服務條款；本工具不提供 CAPTCHA 規避、會員登入或自動下單功能。
