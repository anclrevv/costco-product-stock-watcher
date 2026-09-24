import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decideNotification, type StockObservation } from "../src/domain";
import {
  getProductByCode,
  listPendingNotifications,
  markNotificationDelivered,
  storeObservation,
  upsertProduct,
} from "../src/repository";

describe("D1 repository", () => {
  it("persists products and prevents duplicate restock decisions after state updates", async () => {
    const product = await upsertProduct(env.DB, {
      code: "158030",
      name: "iPhone fixture",
    });
    const outOfStock = observation("out_of_stock", 0, "2026-09-24T00:00:00.000Z");
    await storeObservation(env.DB, product, outOfStock, decideNotification(product, outOfStock, 3));

    const afterBaseline = await getProductByCode(env.DB, "158030");
    expect(afterBaseline?.lastConfirmedStatus).toBe("out_of_stock");

    const inStock = observation("in_stock", 4, "2026-09-24T00:05:00.000Z");
    const restockDecision = decideNotification(afterBaseline!, inStock, 3);
    expect(restockDecision.kind).toBe("restock");
    await storeObservation(env.DB, afterBaseline!, inStock, restockDecision);

    const afterRestock = await getProductByCode(env.DB, "158030");
    expect(afterRestock?.lastConfirmedStatus).toBe("in_stock");
    expect(afterRestock?.lastNotifiedStatus).toBe("in_stock");
    expect(decideNotification(afterRestock!, inStock, 3).kind).toBe("none");

    const pending = await listPendingNotifications(env.DB);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload.decision.kind).toBe("restock");
    await markNotificationDelivered(env.DB, pending[0]!.id);
    expect(await listPendingNotifications(env.DB)).toHaveLength(0);
  });
});

function observation(
  status: StockObservation["status"],
  stockLevel: number,
  observedAt: string,
): StockObservation {
  return {
    status,
    name: "iPhone fixture",
    stockLevel,
    price: 44_999,
    currency: "TWD",
    reason: "fixture",
    evidence: { stockLevel },
    observedAt,
    latencyMs: 20,
    httpStatus: 200,
    errorCode: null,
  };
}
