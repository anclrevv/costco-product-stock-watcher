import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "../src/telegram";

describe("constantTimeEqual", () => {
  it("compares webhook and chat secrets without early-return string checks", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("secret", "secrex")).toBe(false);
    expect(constantTimeEqual("short", "much-longer")).toBe(false);
  });
});
