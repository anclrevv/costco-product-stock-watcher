# Costco Product Stock Watcher｜Costco 商品庫存監控工具

> A Python-based Costco product stock monitor with Telegram notifications.  
> 一個以 Python 撰寫的 Costco 商品庫存監控工具，可定期檢查商品狀態，並透過 Telegram Bot 發送通知。

---

## Overview｜專案簡介

This project is a personal automation practice project built with Python, Playwright, and Telegram Bot API. It monitors selected Costco product pages and sends Telegram notifications when product availability changes.

本專案是一個個人自動化練習專案，使用 Python、Playwright 與 Telegram Bot API 實作 Costco 商品庫存監控流程。程式會定期檢查指定商品頁面的狀態，並在商品庫存狀態發生變化時，透過 Telegram Bot 發送通知。

---

## Features｜功能特色

- Monitor Costco product pages  
  監控 Costco 商品頁面

- Detect product availability based on page content  
  根據頁面內容判斷商品庫存狀態

- Send Telegram notifications when stock status changes  
  當庫存狀態變化時發送 Telegram 通知

- Support scheduled stock checking  
  支援定期檢查商品狀態

- Display timestamps based on the configured timezone  
  支援依照指定時區顯示檢查時間

- Manage runtime settings through environment variables  
  透過環境變數管理執行設定

---

## Tech Stack｜技術架構

| Category | Technology |
|---|---|
| Language｜程式語言 | Python |
| Browser Automation｜瀏覽器自動化 | Playwright |
| HTTP Request｜HTTP 請求 | Requests |
| Timezone｜時區處理 | pytz |
| Notification｜通知服務 | Telegram Bot API |

---

## Project Structure｜專案結構

```text
costco-stock-monitor-bot/
├── README.md
├── .gitignore
├── .env.example
├── requirements.txt
├── src/
│   └── monitor.py
```

---

## Installation｜安裝方式

Install Python dependencies:

安裝 Python 套件：

```bash
pip install -r requirements.txt
```

Install the Playwright Chromium browser:

安裝 Playwright 所需的 Chromium 瀏覽器：

```bash
python -m playwright install chromium
```

For notebook environments such as Google Colab, additional setup may be required:

若在 Google Colab 等 Notebook 環境執行，可能需要額外安裝：

```bash
pip install playwright requests pytz
playwright install --with-deps chromium
```

---

## Configuration｜設定方式

Create a `.env` file from the example file:

由範例檔案建立 `.env` 設定檔：

```bash
cp .env.example .env
```

Example configuration:

設定範例如下：

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
TIMEZONE=Asia/Taipei
CHECK_INTERVAL=300
```

---

## Telegram Bot Setup｜Telegram Bot 設定

1. Create a Telegram bot using BotFather.  
   使用 BotFather 建立 Telegram Bot。

2. Copy the generated bot token.  
   複製產生的 Bot Token。

3. Get your Telegram chat ID.  
   取得 Telegram Chat ID。

4. Add the bot token and chat ID to the `.env` file.  
   將 Bot Token 與 Chat ID 填入 `.env` 檔案。

5. Run the monitor script.  
   執行庫存監控程式。

---

## Usage｜使用方式

Run the monitor script:

執行監控程式：

```bash
python src/monitor.py
```

The script will periodically check the configured Costco product page and send a Telegram notification when the product status changes.

程式會依照設定的檢查間隔，定期檢查 Costco 商品頁面，並在商品狀態變化時發送 Telegram 通知。

---

## Example Notification｜通知範例

```text
Product is now in stock!

Product: Example Product
Status: In Stock
Checked at: 2026-05-13 14:30:00
URL: https://www.costco.com.tw/example-product/p/000000
```

---

## Development Status｜開發狀態

This project is currently maintained as a personal learning and automation practice project.

本專案目前作為個人學習與自動化實作練習使用，主要目標是建立可執行、可維護且易於理解的商品監控流程。

---

## Roadmap｜未來規劃

- Move product URLs to a configuration file  
  將商品網址移至設定檔管理

- Support multiple product monitoring  
  支援多商品監控

- Add stock status history  
  新增庫存狀態歷史紀錄

- Add retry and logging mechanisms  
  加入錯誤重試與日誌紀錄機制

- Support deployment to cloud platforms  
  支援部署至雲端平台

- Add Docker support  
  新增 Docker 支援

- Add GitHub Actions or scheduled execution support  
  新增 GitHub Actions 或排程執行支援

- Improve stock detection logic for different product page states  
  優化不同商品頁面狀態下的庫存判斷邏輯

---

## Disclaimer｜免責聲明

This project is for educational and personal use only. Please use a reasonable check interval and respect the target website's terms of service.

本專案僅供學習與個人用途使用。使用時請設定合理的檢查頻率，並尊重目標網站的服務條款。
