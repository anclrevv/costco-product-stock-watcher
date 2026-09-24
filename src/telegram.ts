import type { Product, StockObservation } from "./domain";
import { canonicalProductUrl, parseCostcoProductCode } from "./domain";
import type { AppEnv } from "./env";
import { fetchCostcoProduct } from "./costco";
import {
  getProductByCode,
  importLegacyProducts,
  listProducts,
  setProductEnabled,
  upsertProduct,
} from "./repository";
import { checkOneProduct, runScheduledChecks } from "./monitor";

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  text?: string;
  chat: TelegramChat;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export async function handleTelegramWebhook(request: Request, env: AppEnv): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const update = (await request.json()) as TelegramUpdate;
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (chatId === undefined || !constantTimeEqual(String(chatId), env.TELEGRAM_CHAT_ID)) {
    return json({ ok: false, error: "unauthorized_chat" }, 403);
  }

  if (update.callback_query) {
    await answerCallbackQuery(env, update.callback_query.id);
    await handleCallback(env, String(chatId), update.callback_query.data ?? "");
    return json({ ok: true });
  }

  const text = update.message?.text?.trim();
  if (!text) return json({ ok: true, ignored: true });
  await handleText(env, String(chatId), text);
  return json({ ok: true });
}

async function handleText(env: AppEnv, chatId: string, text: string): Promise<void> {
  await importLegacyProducts(env);

  const legacyMatch = text.match(/^\/trackcc(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (legacyMatch) {
    await handleLegacyTrackcc(env, chatId, legacyMatch[1]?.trim() ?? "help");
    return;
  }

  if (/^\/(?:start|help)(?:@\w+)?$/i.test(text)) {
    await sendHelp(env, chatId);
    return;
  }

  if (/^\/(?:watchlist|list)(?:@\w+)?$/i.test(text)) {
    await sendWatchlist(env, chatId);
    return;
  }

  if (/^\/status(?:@\w+)?$/i.test(text)) {
    await sendServiceStatus(env, chatId);
    return;
  }

  const checkMatch = text.match(/^\/check(?:@\w+)?(?:\s+([A-Za-z0-9-]+))?$/i);
  if (checkMatch) {
    if (checkMatch[1]) await checkAndReply(env, chatId, checkMatch[1]);
    else {
      await sendMessage(env, chatId, "正在檢查全部商品，完成後會回報結果。");
      await runScheduledChecks(env, { notify: false });
      await sendWatchlist(env, chatId);
    }
    return;
  }

  const pauseMatch = text.match(/^\/pause(?:@\w+)?\s+([A-Za-z0-9-]+)$/i);
  if (pauseMatch?.[1]) {
    await toggleProduct(env, chatId, pauseMatch[1], false);
    return;
  }

  const resumeMatch = text.match(/^\/resume(?:@\w+)?\s+([A-Za-z0-9-]+)$/i);
  if (resumeMatch?.[1]) {
    await toggleProduct(env, chatId, resumeMatch[1], true);
    return;
  }

  const removeMatch = text.match(/^\/remove(?:@\w+)?\s+([A-Za-z0-9-]+)$/i);
  if (removeMatch?.[1]) {
    await requestRemoveConfirmation(env, chatId, removeMatch[1]);
    return;
  }

  const addInput = text.replace(/^\/add(?:@\w+)?\s+/i, "").trim();
  const code = parseCostcoProductCode(addInput);
  if (code) {
    await addProduct(env, chatId, code);
    return;
  }

  await sendMessage(env, chatId, "我看不懂這個指令。直接貼 Costco 商品網址即可新增監控，或輸入 /help 查看說明。");
}

async function handleLegacyTrackcc(env: AppEnv, chatId: string, input: string): Promise<void> {
  const [verb = "help", ...rest] = input.split(/\s+/);
  const argument = rest.join(" ").trim();
  switch (verb.toLowerCase()) {
    case "help":
      await sendHelp(env, chatId);
      return;
    case "list":
      await sendWatchlist(env, chatId);
      return;
    case "add": {
      const code = parseCostcoProductCode(argument);
      if (code) await addProduct(env, chatId, code);
      else await sendMessage(env, chatId, "請提供有效的 Costco 台灣商品網址。");
      return;
    }
    case "remove":
      await requestRemoveConfirmation(env, chatId, argument);
      return;
    case "check":
      await runScheduledChecks(env, { notify: false });
      await sendWatchlist(env, chatId);
      return;
    default:
      await sendHelp(env, chatId);
  }
}

async function handleCallback(env: AppEnv, chatId: string, data: string): Promise<void> {
  const [action, code] = data.split(":", 2);
  if (!code) return;

  switch (action) {
    case "check":
      await checkAndReply(env, chatId, code);
      break;
    case "pause":
      await toggleProduct(env, chatId, code, false);
      break;
    case "resume":
      await toggleProduct(env, chatId, code, true);
      break;
    case "remove":
      await requestRemoveConfirmation(env, chatId, code);
      break;
    case "confirm_remove":
      await toggleProduct(env, chatId, code, false, "已從監控清單封存");
      break;
  }
}

async function addProduct(env: AppEnv, chatId: string, code: string): Promise<void> {
  await sendMessage(env, chatId, `正在讀取 Costco 商品 ${code}…`);
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
    [[
      { text: "立即檢查", callback_data: `check:${code}` },
      { text: "暫停", callback_data: `pause:${code}` },
    ]],
  );
}

async function checkAndReply(env: AppEnv, chatId: string, code: string): Promise<void> {
  const product = await getProductByCode(env.DB, code);
  if (!product) {
    await sendMessage(env, chatId, `找不到商品 ${code}。`);
    return;
  }
  const observation = await checkOneProduct(env, product, { notify: false });
  await sendMessage(
    env,
    chatId,
    `${product.name}\n狀態：${statusLabel(observation.status)}\n${observation.reason}\n檢查時間：${formatTaipeiTime(observation.observedAt)}`,
  );
}

async function sendWatchlist(env: AppEnv, chatId: string): Promise<void> {
  const products = await listProducts(env.DB);
  if (products.length === 0) {
    await sendMessage(env, chatId, "監控清單目前是空的。直接貼上 Costco 商品網址即可新增。");
    return;
  }

  for (const product of products) {
    const state = product.enabled ? statusLabel(product.currentStatus) : "⏸️ 已暫停";
    await sendMessage(
      env,
      chatId,
      `${product.name}\n編號：${product.code}\n狀態：${state}\n最後檢查：${formatTaipeiTime(product.lastCheckedAt)}\n${product.url}`,
      [[
        { text: "立即檢查", callback_data: `check:${product.code}` },
        product.enabled
          ? { text: "暫停", callback_data: `pause:${product.code}` }
          : { text: "恢復", callback_data: `resume:${product.code}` },
        { text: "移除", callback_data: `remove:${product.code}` },
      ]],
    );
  }
}

async function sendServiceStatus(env: AppEnv, chatId: string): Promise<void> {
  const products = await listProducts(env.DB);
  const enabled = products.filter((product) => product.enabled);
  const failed = enabled.filter((product) => product.consecutiveFailures > 0);
  const lastChecked = enabled
    .map((product) => product.lastCheckedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  await sendMessage(
    env,
    chatId,
    [
      "📊 Costco Stock Watcher v2",
      `啟用商品：${enabled.length}/${products.length}`,
      `檢查異常：${failed.length}`,
      `最後檢查：${formatTaipeiTime(lastChecked ?? null)}`,
      "排程：每 5 分鐘",
    ].join("\n"),
  );
}

async function toggleProduct(
  env: AppEnv,
  chatId: string,
  code: string,
  enabled: boolean,
  customMessage?: string,
): Promise<void> {
  const changed = await setProductEnabled(env.DB, code, enabled);
  await sendMessage(
    env,
    chatId,
    changed ? `${customMessage ?? (enabled ? "已恢復監控" : "已暫停監控")}：${code}` : `找不到商品：${code}`,
  );
}

async function requestRemoveConfirmation(env: AppEnv, chatId: string, code: string): Promise<void> {
  const product = await getProductByCode(env.DB, code);
  if (!product) {
    await sendMessage(env, chatId, `找不到商品：${code}`);
    return;
  }
  await sendMessage(env, chatId, `確定要將「${product.name}」從監控清單封存嗎？歷史紀錄會保留。`, [[
    { text: "確認移除", callback_data: `confirm_remove:${code}` },
    { text: "保留", callback_data: `check:${code}` },
  ]]);
}

async function sendHelp(env: AppEnv, chatId: string): Promise<void> {
  await sendMessage(
    env,
    chatId,
    [
      "Costco Stock Watcher v2",
      "",
      "直接貼 Costco 台灣商品網址即可加入監控。",
      "/watchlist — 查看商品",
      "/check [商品編號] — 立即檢查",
      "/pause 商品編號 — 暫停",
      "/resume 商品編號 — 恢復",
      "/remove 商品編號 — 封存",
      "/status — 服務狀態",
    ].join("\n"),
  );
}

async function sendMessage(
  env: AppEnv,
  chatId: string,
  text: string,
  inlineKeyboard?: InlineKeyboardButton[][],
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
    }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
}

async function answerCallbackQuery(env: AppEnv, callbackQueryId: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
  if (!response.ok) console.warn(JSON.stringify({ event: "telegram_callback_answer_failed", status: response.status }));
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

function formatTaipeiTime(value: string | null): string {
  if (!value) return "尚未檢查";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date(value));
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
