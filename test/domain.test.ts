import { describe, expect, it } from "vitest";
import {
  canonicalProductUrl,
  decideNotification,
  parseCostcoProductCode,
  type Product,
  type StockObservation,
} from "../src/domain";

describe("parseCostcoProductCode", () => {
  it("accepts Costco Taiwan product URLs", () => {
    expect(parseCostcoProductCode("https://www.costco.com.tw/p/158030")).toBe("158030");
    expect(
      parseCostcoProductCode("https://www.costco.com.tw/Computers/iPad/p/153037?lang=zh_TW"),
    ).toBe("153037");
  });

  it("accepts a plain product code", () => {
    expect(parseCostcoProductCode("158053-B")).toBe("158053-B");
  });

  it("rejects untrusted hosts and ambiguous input", () => {
    expect(parseCostcoProductCode("https://example.com/p/158030")).toBeNull();
    expect(parseCostcoProductCode("javascript:alert(1)")).toBeNull();
    expect(parseCostcoProductCode("123")).toBeNull();
  });

  it("creates one canonical URL", () => {
    expect(canonicalProductUrl("158053-B")).toBe("https://www.costco.com.tw/p/158053-B");
  });
});

describe("decideNotification", () => {
  it("does not alert on the first in-stock baseline", () => {
    expect(decideNotification(product(), observation("in_stock"), 3).kind).toBe("none");
  });

  it("alerts only on a confirmed transition to in stock", () => {
    expect(
      decideNotification(product({ lastConfirmedStatus: "out_of_stock" }), observation("in_stock"), 3)
        .kind,
    ).toBe("restock");
  });

  it("alerts after the configured consecutive failure threshold", () => {
    expect(
      decideNotification(product({ consecutiveFailures: 2 }), observation("error"), 3).kind,
    ).toBe("failure");
  });

  it("alerts when monitoring recovers after a failure alert", () => {
    expect(
      decideNotification(
        product({ failureNotifiedAt: "2026-09-24T00:00:00.000Z" }),
        observation("out_of_stock"),
        3,
      ).kind,
    ).toBe("recovery");
  });
});

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "costco-158030",
    code: "158030",
    name: "Test Product",
    url: "https://www.costco.com.tw/p/158030",
    enabled: true,
    checkIntervalSeconds: 300,
    currentStatus: "unknown",
    lastConfirmedStatus: null,
    lastStockLevel: null,
    lastPrice: null,
    currency: null,
    lastCheckedAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    failureNotifiedAt: null,
    lastNotifiedStatus: null,
    lastNotifiedAt: null,
    ...overrides,
  };
}

function observation(status: StockObservation["status"]): StockObservation {
  return {
    status,
    name: "Test Product",
    stockLevel: status === "in_stock" ? 5 : null,
    price: 100,
    currency: "TWD",
    reason: "fixture",
    evidence: {},
    observedAt: "2026-09-24T00:00:00.000Z",
    latencyMs: 10,
    httpStatus: 200,
    errorCode: null,
  };
}
