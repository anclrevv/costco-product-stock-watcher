"""
Costco Stock Monitor Bot

A Python script for monitoring Costco product availability and sending Telegram
notifications when product status changes.

Before running:
1. Install dependencies:
   pip install playwright requests pytz python-dotenv
   python -m playwright install chromium

2. Create a .env file:
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
   TELEGRAM_CHAT_ID=your_telegram_chat_id_here
   TIMEZONE=Asia/Taipei
   CHECK_INTERVAL=300

3. Create a config.json file:
   {
     "products": [
       {
         "name": "Example Product",
         "url": "https://www.costco.com.tw/example-product/p/000000"
       }
     ]
   }

Run:
   python src/monitor.py
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import pytz
import requests
from dotenv import load_dotenv
from playwright.async_api import Page, async_playwright


# ---------------------------------------------------------------------------
# Environment settings
# ---------------------------------------------------------------------------

load_dotenv()

TIMEZONE = os.getenv("TIMEZONE", "Asia/Taipei")
CHECK_INTERVAL = int(os.getenv("CHECK_INTERVAL", "300"))
CONFIG_PATH = Path(os.getenv("CONFIG_PATH", "config.json"))

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")


# ---------------------------------------------------------------------------
# Costco page detection patterns
# ---------------------------------------------------------------------------

IN_STOCK_TEXT = re.compile(r"(加入購物車|立即購買|Add to Cart|Buy Now)", re.I)
OUT_OF_STOCK_TEXT = re.compile(r"(到貨通知|缺貨|補貨通知|Out of Stock|Notify Me)", re.I)


@dataclass
class Product:
    name: str
    url: str


@dataclass
class StockResult:
    product: Product
    status: str
    status_text: str
    title: str
    seen_texts: list[str]
    checked_at: str
    error: str | None = None


def now_ts() -> str:
    """Return current timestamp based on configured timezone."""
    tz = pytz.timezone(TIMEZONE)
    return datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S")


def load_products(config_path: Path = CONFIG_PATH) -> list[Product]:
    """Load product list from config.json."""
    if not config_path.exists():
        raise FileNotFoundError(
            f"Config file not found: {config_path}\n"
            "Please copy config.example.json to config.json and edit it."
        )

    with config_path.open("r", encoding="utf-8") as file:
        data: dict[str, Any] = json.load(file)

    items = data.get("products", [])
    if not isinstance(items, list) or not items:
        raise ValueError("config.json must contain a non-empty 'products' list.")

    products: list[Product] = []
    for item in items:
        name = str(item.get("name", "")).strip()
        url = str(item.get("url", "")).strip()

        if not name or not url:
            raise ValueError("Each product must include both 'name' and 'url'.")

        products.append(Product(name=name, url=url))

    return products


def send_telegram_message(text: str) -> int | None:
    """Send a Telegram message and return message_id if successful."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("Telegram settings are missing. Please check .env.")
        return None

    response = requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
        json={
            "chat_id": TELEGRAM_CHAT_ID,
            "text": text,
            "disable_web_page_preview": True,
        },
        timeout=15,
    )

    if response.ok:
        return response.json().get("result", {}).get("message_id")

    print(f"Telegram send error: {response.status_code} {response.text}")
    return None


def edit_telegram_message(message_id: int, text: str) -> bool:
    """Edit an existing Telegram message."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID or not message_id:
        return False

    response = requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/editMessageText",
        json={
            "chat_id": TELEGRAM_CHAT_ID,
            "message_id": message_id,
            "text": text,
            "disable_web_page_preview": True,
        },
        timeout=15,
    )

    if response.ok:
        return True

    print(f"Telegram edit error: {response.status_code} {response.text}")
    return False


async def detect_stock_status(page: Page) -> tuple[str, str, list[str]]:
    """
    Detect stock status based on visible and enabled buttons/links.

    Returns:
        status: "in_stock", "out_of_stock", or "unknown"
        status_text: human-readable status text
        seen_texts: collected button/link text for debugging
    """
    candidates = []

    try:
        candidates.extend(await page.get_by_role("button").all())
    except Exception:
        pass

    try:
        candidates.extend(await page.get_by_role("link").all())
    except Exception:
        pass

    seen_texts: list[str] = []
    out_of_stock_marker = False

    for element in candidates:
        try:
            text = (await element.inner_text()).strip()
        except Exception:
            continue

        if not text:
            continue

        seen_texts.append(text[:80])

        if OUT_OF_STOCK_TEXT.search(text):
            out_of_stock_marker = True

        if IN_STOCK_TEXT.search(text):
            try:
                is_visible = await element.is_visible()
                is_enabled = await element.is_enabled()
            except Exception:
                continue

            if is_visible and is_enabled:
                return "in_stock", "✅ 有貨", seen_texts[:10]

    if out_of_stock_marker:
        return "out_of_stock", "❌ 缺貨", seen_texts[:10]

    return "unknown", "❓ 未判定", seen_texts[:10]


async def check_product(page: Page, product: Product) -> StockResult:
    """Check a single product page."""
    checked_at = now_ts()

    try:
        await page.goto(product.url, wait_until="networkidle", timeout=60000)
        await page.wait_for_load_state("domcontentloaded")
        await page.wait_for_timeout(1200)

        title = await page.title()
        status, status_text, seen_texts = await detect_stock_status(page)

        return StockResult(
            product=product,
            status=status,
            status_text=status_text,
            title=title,
            seen_texts=seen_texts,
            checked_at=checked_at,
        )

    except Exception as exc:
        return StockResult(
            product=product,
            status="error",
            status_text="⚠️ 檢查錯誤",
            title="",
            seen_texts=[],
            checked_at=checked_at,
            error=str(exc),
        )


def build_status_message(
    results: list[StockResult],
    check_count: int,
    since_last: str,
) -> str:
    """Build the status message displayed in Telegram."""
    lines = [
        "📊 Costco Stock Monitor",
        f"最後檢查：{now_ts()}",
        f"檢查次數：第 {check_count} 次",
        f"距上次：{since_last}",
        "",
    ]

    for result in results:
        lines.append(f"{result.product.name}")
        lines.append(f"狀態：{result.status_text}")

        if result.error:
            lines.append(f"錯誤：{result.error}")

        lines.append(f"URL：{result.product.url}")
        lines.append("")

    return "\n".join(lines).strip()


def build_stock_alert(result: StockResult) -> str:
    """Build a Telegram alert message for in-stock products."""
    return (
        "🛒 商品目前有貨！\n\n"
        f"商品：{result.product.name}\n"
        f"狀態：{result.status_text}\n"
        f"時間：{result.checked_at}\n"
        f"URL：{result.product.url}"
    )


async def watch() -> None:
    """Main monitoring loop."""
    products = load_products()

    send_telegram_message(
        "🟢 Costco Stock Monitor started\n"
        f"商品數量：{len(products)}\n"
        f"檢查間隔：{CHECK_INTERVAL} 秒\n"
        f"開始時間：{now_ts()}"
    )

    status_message_id: int | None = None
    check_count = 0
    last_check_time: float | None = None
    last_status_by_url: dict[str, str] = {}

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(
            locale="zh-TW",
            timezone_id=TIMEZONE,
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = await context.new_page()

        try:
            while True:
                current_time = time.time()
                check_count += 1

                if last_check_time is None:
                    since_last = "—"
                else:
                    since_last = f"{current_time - last_check_time:.1f} 秒"

                last_check_time = current_time
                results: list[StockResult] = []

                for product in products:
                    result = await check_product(page, product)
                    results.append(result)

                    previous_status = last_status_by_url.get(product.url)
                    last_status_by_url[product.url] = result.status

                    if result.status == "in_stock" and previous_status != "in_stock":
                        send_telegram_message(build_stock_alert(result))

                    # Avoid hitting pages too quickly when monitoring multiple products.
                    await asyncio.sleep(random.uniform(1.0, 3.0))

                status_message = build_status_message(
                    results=results,
                    check_count=check_count,
                    since_last=since_last,
                )

                if status_message_id:
                    edited = edit_telegram_message(status_message_id, status_message)
                    if not edited:
                        status_message_id = send_telegram_message(status_message)
                else:
                    status_message_id = send_telegram_message(status_message)

                jitter = random.uniform(-10, 10)
                sleep_seconds = max(60, CHECK_INTERVAL + jitter)
                await asyncio.sleep(sleep_seconds)

        finally:
            await context.close()
            await browser.close()


if __name__ == "__main__":
    try:
        asyncio.run(watch())
    except KeyboardInterrupt:
        print("Monitor stopped by user.")
