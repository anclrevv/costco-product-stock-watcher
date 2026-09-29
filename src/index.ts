import type { AppEnv } from "./env";
import { runScheduledChecks } from "./monitor";
import { importLegacyProducts, listProducts } from "./repository";
import { constantTimeEqual, handleTelegramWebhook } from "./telegram";

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "Costco Stock Watcher v2",
        routes: { health: "/health", telegramWebhook: "/tg-webhook/{secret}" },
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      try {
        const products = await listProducts(env.DB);
        const enabled = products.filter((product) => product.enabled);
        const lastCheckedAt = enabled
          .map((product) => product.lastCheckedAt)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1);
        return json({
          ok: true,
          service: "Costco Stock Watcher v2",
          products: { total: products.length, enabled: enabled.length },
          lastCheckedAt: lastCheckedAt ?? null,
        });
      } catch (error) {
        return json(
          { ok: false, error: "database_unavailable", detail: safeErrorMessage(error) },
          503,
        );
      }
    }

    const webhookPrefix = "/tg-webhook/";
    if (url.pathname.startsWith(webhookPrefix)) {
      const suppliedSecret = decodeURIComponent(url.pathname.slice(webhookPrefix.length));
      if (!constantTimeEqual(suppliedSecret, env.TG_WEBHOOK_SECRET)) {
        return json({ ok: false, error: "invalid_webhook_secret" }, 401);
      }
      return handleTelegramWebhook(request, env);
    }

    if (url.pathname === "/internal/status") {
      if (!isAdminRequest(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      await importLegacyProducts(env);
      return json({ ok: true, products: await listProducts(env.DB) });
    }

    if (request.method === "POST" && url.pathname === "/internal/check") {
      if (!isAdminRequest(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      await runScheduledChecks(env);
      return json({ ok: true });
    }

    return json({ ok: false, error: "not_found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledChecks(env));
  },
} satisfies ExportedHandler<AppEnv>;

function isAdminRequest(request: Request, env: AppEnv): boolean {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return Boolean(env.ADMIN_TOKEN) && constantTimeEqual(supplied, env.ADMIN_TOKEN);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "Unknown error";
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}
