import type { StockObservation, StockStatus } from "./domain";

const API_BASE = "https://www.costco.com.tw/rest/v2/taiwan/products";
const REQUEST_TIMEOUT_MS = 20_000;

interface CostcoPrice {
  value?: unknown;
  currencyIso?: unknown;
}

interface CostcoStock {
  stockLevel?: unknown;
  stockLevelStatus?: unknown;
}

interface CostcoProductPayload {
  code?: unknown;
  name?: unknown;
  purchasable?: unknown;
  buyNowEnabled?: unknown;
  availableForPreorder?: unknown;
  isProductAvailable?: unknown;
  basePrice?: CostcoPrice;
  price?: CostcoPrice;
  stock?: CostcoStock;
}

export function buildProductApiUrl(code: string): string {
  return `${API_BASE}/${encodeURIComponent(code)}/?fields=FULL&lang=zh_TW&curr=TWD`;
}

export async function fetchCostcoProduct(
  code: string,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<StockObservation> {
  const startedAt = Date.now();
  const observedAt = now().toISOString();
  const apiUrl = buildProductApiUrl(code);

  try {
    const response = await fetcher(apiUrl, {
      headers: {
        accept: "application/json",
        "accept-language": "zh-TW,zh;q=0.9,en;q=0.7",
        "user-agent": "CostcoStockWatcher/2.0 (+personal-use)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const latencyMs = Date.now() - startedAt;
    if (response.status === 404) {
      return observation("not_found", observedAt, latencyMs, response.status, {
        reason: "Costco API returned 404",
      });
    }

    if (response.status === 403 || response.status === 429) {
      return observation("blocked", observedAt, latencyMs, response.status, {
        reason: `Costco API blocked the request (${response.status})`,
      });
    }

    if (!response.ok) {
      return observation("error", observedAt, latencyMs, response.status, {
        reason: `Costco API returned HTTP ${response.status}`,
        errorCode: "upstream_http_error",
      });
    }

    const payload = (await response.json()) as CostcoProductPayload;
    return classifyCostcoPayload(payload, observedAt, latencyMs, response.status);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown Costco API error";
    return observation("error", observedAt, Date.now() - startedAt, null, {
      reason,
      errorCode: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "fetch_error",
    });
  }
}

export function classifyCostcoPayload(
  payload: CostcoProductPayload,
  observedAt = new Date().toISOString(),
  latencyMs = 0,
  httpStatus: number | null = 200,
): StockObservation {
  const code = stringOrNull(payload.code);
  const name = stringOrNull(payload.name);
  const stockLevelStatus = stringOrNull(payload.stock?.stockLevelStatus);
  const stockLevel = finiteNumberOrNull(payload.stock?.stockLevel);
  const price = finiteNumberOrNull(payload.basePrice?.value ?? payload.price?.value);
  const currency = stringOrNull(payload.basePrice?.currencyIso ?? payload.price?.currencyIso);
  const purchasable = payload.purchasable === true;
  const buyNowEnabled = payload.buyNowEnabled === true;
  const availableForPreorder = payload.availableForPreorder === true;

  const evidence = {
    code,
    stockLevelStatus,
    stockLevel,
    purchasable,
    buyNowEnabled,
    availableForPreorder,
    isProductAvailable: payload.isProductAvailable === true,
  };

  if (!code || !name) {
    return {
      status: "not_found",
      name,
      stockLevel,
      price,
      currency,
      reason: "Costco API response did not contain a product identity",
      evidence,
      observedAt,
      latencyMs,
      httpStatus,
      errorCode: "missing_product_identity",
    };
  }

  const normalizedStatus = stockLevelStatus?.toLowerCase() ?? "";
  if (
    normalizedStatus === "instock" &&
    purchasable &&
    (stockLevel === null || stockLevel > 0)
  ) {
    return {
      status: "in_stock",
      name,
      stockLevel,
      price,
      currency,
      reason: "Costco API confirmed an in-stock, purchasable product",
      evidence,
      observedAt,
      latencyMs,
      httpStatus,
      errorCode: null,
    };
  }

  if (normalizedStatus === "outofstock" || stockLevel === 0) {
    return {
      status: "out_of_stock",
      name,
      stockLevel,
      price,
      currency,
      reason: "Costco API confirmed the product is out of stock",
      evidence,
      observedAt,
      latencyMs,
      httpStatus,
      errorCode: null,
    };
  }

  return {
    status: "unknown",
    name,
    stockLevel,
    price,
    currency,
    reason: "Costco API response did not contain a trustworthy stock signal",
    evidence,
    observedAt,
    latencyMs,
    httpStatus,
    errorCode: "unrecognized_stock_state",
  };
}

function observation(
  status: StockStatus,
  observedAt: string,
  latencyMs: number,
  httpStatus: number | null,
  options: { reason: string; errorCode?: string },
): StockObservation {
  return {
    status,
    name: null,
    stockLevel: null,
    price: null,
    currency: null,
    reason: options.reason,
    evidence: {},
    observedAt,
    latencyMs,
    httpStatus,
    errorCode: options.errorCode ?? null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
