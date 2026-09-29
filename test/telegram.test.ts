import { describe, expect, it } from "vitest";
import { constantTimeEqual, parseTrackccProductCode } from "../src/telegram";

describe("constantTimeEqual", () => {
  it("compares webhook and chat secrets without early-return string checks", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("secret", "secrex")).toBe(false);
    expect(constantTimeEqual("short", "much-longer")).toBe(false);
  });
});

describe("parseTrackccProductCode", () => {
  it("accepts only /trackcc followed by a Costco URL", () => {
    expect(parseTrackccProductCode("/trackcc https://www.costco.com.tw/p/363984")).toBe("363984");
    expect(parseTrackccProductCode("/trackcc@costco_bot https://www.costco.com.tw/p/363984")).toBe("363984");
  });

  it("silently rejects other commands and bare links", () => {
    expect(parseTrackccProductCode("https://www.costco.com.tw/p/363984")).toBeNull();
    expect(parseTrackccProductCode("/trackcc add https://www.costco.com.tw/p/363984")).toBeNull();
    expect(parseTrackccProductCode("/status")).toBeNull();
  });
});
