import type { NotificationDecision, Product, StockObservation } from "./domain";
import type { AppEnv } from "./env";

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export async function sendDecisionNotification(
  env: AppEnv,
  product: Product,
  observation: StockObservation,
  decision: NotificationDecision,
): Promise<void> {
  if (decision.kind === "none") return;

  if (decision.kind === "restock") {
    const stock = observation.stockLevel === null ? "未提供" : String(observation.stockLevel);
    const price = formatPrice(observation.price, observation.currency);
    await sendMessage(
      env,
      [
        "🛒 Costco 商品已確認補貨",
        "",
        product.name,
        `庫存：${stock}`,
        price ? `價格：${price}` : null,
        `時間：${formatTaipeiTime(observation.observedAt)}`,
        product.url,
      ]
        .filter(Boolean)
        .join("\n"),
      [[
        { text: "立即查看", url: product.url },
        { text: "暫停監控", callback_data: `pause:${product.code}` },
      ]],
    );
    return;
  }

  if (decision.kind === "failure") {
    await sendMessage(
      env,
      `⚠️ Costco 監控需要注意\n\n${product.name}\n${observation.reason}\n${product.url}`,
    );
    return;
  }

  await sendMessage(
    env,
    `✅ Costco 監控已恢復\n\n${product.name}\n目前狀態：${statusLabel(observation.status)}`,
  );
}

async function sendMessage(
  env: AppEnv,
  text: string,
  inlineKeyboard?: InlineKeyboardButton[][],
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
      reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
    }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
}

function statusLabel(status: StockObservation["status"]): string {
  const labels: Record<typeof status, string> = {
    in_stock: "✅ 有貨",
    out_of_stock: "❌ 缺貨",
    unknown: "❓ 無法確認",
    blocked: "🚧 存取受阻",
    not_found: "🔍 商品不存在或已下架",
    error: "⚠️ 檢查錯誤",
  };
  return labels[status];
}

function formatPrice(price: number | null, currency: string | null): string | null {
  if (price === null) return null;
  return new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: currency ?? "TWD",
    maximumFractionDigits: 0,
  }).format(price);
}

function formatTaipeiTime(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date(value));
}
