export const STOCK_STATUSES = [
  "in_stock",
  "out_of_stock",
  "unknown",
  "blocked",
  "not_found",
  "error",
] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];
export type ConfirmedStockStatus = Extract<StockStatus, "in_stock" | "out_of_stock">;

export interface Product {
  id: string;
  code: string;
  name: string;
  url: string;
  enabled: boolean;
  checkIntervalSeconds: number;
  currentStatus: StockStatus;
  lastConfirmedStatus: ConfirmedStockStatus | null;
  lastStockLevel: number | null;
  lastPrice: number | null;
  currency: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  failureNotifiedAt: string | null;
  lastNotifiedStatus: ConfirmedStockStatus | null;
  lastNotifiedAt: string | null;
}

export interface StockObservation {
  status: StockStatus;
  name: string | null;
  stockLevel: number | null;
  price: number | null;
  currency: string | null;
  reason: string;
  evidence: Record<string, unknown>;
  observedAt: string;
  latencyMs: number;
  httpStatus: number | null;
  errorCode: string | null;
}

export interface NotificationDecision {
  kind: "restock" | "failure" | "recovery" | "none";
  reason: string;
}

export interface NotificationPayload {
  product: Product;
  observation: StockObservation;
  decision: NotificationDecision;
}

export function isConfirmedStatus(status: StockStatus): status is ConfirmedStockStatus {
  return status === "in_stock" || status === "out_of_stock";
}

export function decideNotification(
  product: Product,
  observation: StockObservation,
  failureAlertThreshold: number,
): NotificationDecision {
  if (isConfirmedStatus(observation.status)) {
    if (product.failureNotifiedAt) {
      return { kind: "recovery", reason: "monitor_recovered" };
    }

    if (
      observation.status === "in_stock" &&
      product.lastConfirmedStatus !== null &&
      product.lastConfirmedStatus !== "in_stock"
    ) {
      return { kind: "restock", reason: "confirmed_transition_to_in_stock" };
    }

    return { kind: "none", reason: "baseline_or_unchanged" };
  }

  const nextFailures = product.consecutiveFailures + 1;
  if (
    nextFailures >= failureAlertThreshold &&
    !product.failureNotifiedAt &&
    observation.status !== "not_found"
  ) {
    return { kind: "failure", reason: "consecutive_check_failures" };
  }

  if (observation.status === "not_found" && !product.failureNotifiedAt) {
    return { kind: "failure", reason: "product_not_found" };
  }

  return { kind: "none", reason: "failure_below_threshold_or_already_notified" };
}

export function parseCostcoProductCode(value: string): string | null {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9-]{4,32}$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || !isAllowedCostcoHost(url.hostname)) return null;
  const match = url.pathname.match(/\/p\/([A-Za-z0-9-]{4,32})(?:\/|$)/i);
  return match?.[1] ?? null;
}

export function canonicalProductUrl(code: string): string {
  return `https://www.costco.com.tw/p/${encodeURIComponent(code)}`;
}

export function productId(code: string): string {
  return `costco-${code}`;
}

function isAllowedCostcoHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "costco.com.tw" || normalized === "www.costco.com.tw";
}
