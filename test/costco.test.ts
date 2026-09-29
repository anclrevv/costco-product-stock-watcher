import { describe, expect, it } from "vitest";
import { classifyCostcoPayload } from "../src/costco";

describe("classifyCostcoPayload", () => {
  it("requires a positive, purchasable in-stock signal", () => {
    const result = classifyCostcoPayload({
      code: "363984",
      name: "Schiff Move Free",
      purchasable: true,
      buyNowEnabled: false,
      stock: { stockLevel: 374, stockLevelStatus: "inStock" },
      basePrice: { value: 1409, currencyIso: "TWD" },
    });

    expect(result.status).toBe("in_stock");
    expect(result.stockLevel).toBe(374);
    expect(result.price).toBe(1409);
  });

  it("treats zero stock as out of stock even when purchasable flags are true", () => {
    const result = classifyCostcoPayload({
      code: "158030",
      name: "iPhone",
      purchasable: true,
      buyNowEnabled: true,
      stock: { stockLevel: 0, stockLevelStatus: "outOfStock" },
    });

    expect(result.status).toBe("out_of_stock");
  });

  it("does not turn an incomplete API response into an out-of-stock result", () => {
    const result = classifyCostcoPayload({
      categories: [],
      isProductAvailable: false,
    } as never);

    expect(result.status).toBe("not_found");
    expect(result.errorCode).toBe("missing_product_identity");
  });

  it("uses unknown for a real product without a trustworthy stock signal", () => {
    const result = classifyCostcoPayload({ code: "123456", name: "Product" });
    expect(result.status).toBe("unknown");
  });
});
