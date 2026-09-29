import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Worker HTTP surface", () => {
  it("exposes a minimal public health response without watchlist details", async () => {
    const response = await exports.default.fetch("http://example.com/health");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("states");
  });

  it("protects internal status", async () => {
    const response = await exports.default.fetch("http://example.com/internal/status");
    expect(response.status).toBe(401);
  });
});
