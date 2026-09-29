import type { Product, StockObservation } from "./domain";
import { canonicalProductUrl, parseCostcoProductCode } from "./domain";
import type { AppEnv } from "./env";
import { fetchCostcoProduct } from "./costco";
import { getProductByCode, upsertProduct } from "./repository";
import { checkOneProduct } from "./monitor";

interface TelegramMessage {
  text?: string;
  chat?: { id?: number };
}

interface TelegramUpdate {
  message?: TelegramMessage;
}

/**
 * The Telegram surface deliberately has one command only. Reserving the
 * namespace now means future commands can be introduced without responding to
 * arbitrary chat messages.
 */
export function parseTrackccProductCode(text: string): string | null {
  const match = text.trim().match(/^\/trackcc(?:@\w+)?\s+(https?:\/\/\S+)\s*$/i);
  return match?.[1] ? parseCostcoProductCode(match[1]) : null;
}

export async function handleTelegramWebhook(request: Request, env: AppEnv): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return json({ ok: true, ignored: true });
  }

  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim();
  if (chatId === undefined || !text || !constantTimeEqual(String(chatId), env.TELEGRAM_CHAT_ID)) {
    return json({ ok: true, ignored: true });
  }

  const code = parseTrackccProductCode(text);
  if (!code) return json({ ok: true, ignored: true });

  await addProduct(env, String(chatId), code);
  return json({ ok: true });
}

async function addProduct(env: AppEnv, chatId: string, code: string): Promise<void> {
  const observation = await fetchCostcoProduct(code);
  if (!observation.name || observation.status === "not_found") {
    await sendMessage(env, chatId, `無法確認商品 ${code}。${observation.reason}`);
    return;
  }

  const existing = await getProductByCode(env.DB, code);
  const product = await upsertProduct(env.DB, {
    code,
    name: observation.name,
    enabled: true,
  });
  await checkOneProduct(env, product, { notify: false, observation });

  await sendMessage(
    env,
    chatId,
    [
      existing ? "✅ 已恢復商品監控" : "✅ 已加入監控",
      "",
      observation.name,
      `狀態：${statusLabel(observation.status)}`,
      observation.stockLevel === null ? null : `庫存：${observation.stockLevel}`,
      formatPrice(observation.price, observation.currency),
      canonicalProductUrl(code),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function sendMessage(env: AppEnv, chatId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
}

function statusLabel(status: StockObservation["status"] | Product["currentStatus"]): string {
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

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
