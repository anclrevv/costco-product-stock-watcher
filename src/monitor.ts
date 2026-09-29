import { fetchCostcoProduct } from "./costco";
import { decideNotification, type Product, type StockObservation } from "./domain";
import type { AppEnv } from "./env";
import {
  acquireRunLock,
  importLegacyProducts,
  listProducts,
  listPendingNotifications,
  markNotificationDelivered,
  markNotificationFailed,
  releaseRunLock,
  storeObservation,
} from "./repository";
import { sendDecisionNotification } from "./notifications";

interface CheckOptions {
  notify: boolean;
  observation?: StockObservation;
}

interface RunOptions {
  notify?: boolean;
}

export async function runScheduledChecks(env: AppEnv, options: RunOptions = {}): Promise<void> {
  const owner = crypto.randomUUID();
  const lockName = "stock-check";
  const acquired = await acquireRunLock(env.DB, lockName, owner);
  if (!acquired) {
    console.info(JSON.stringify({ event: "monitor_run_skipped", reason: "lock_held" }));
    return;
  }

  try {
    const imported = await importLegacyProducts(env);
    const products = await listProducts(env.DB, true);
    console.info(JSON.stringify({ event: "monitor_run_started", products: products.length, imported }));

    const concurrency = positiveInteger(env.CHECK_CONCURRENCY, 2);
    await mapWithConcurrency(products, concurrency, async (product) => {
      try {
        await checkOneProduct(env, product, { notify: options.notify !== false });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "product_check_unhandled_error",
            productId: product.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });

    if (options.notify !== false) await flushPendingNotifications(env);

    console.info(JSON.stringify({ event: "monitor_run_finished", products: products.length }));
  } finally {
    await releaseRunLock(env.DB, lockName, owner);
  }
}

export async function checkOneProduct(
  env: AppEnv,
  product: Product,
  options: CheckOptions,
): Promise<StockObservation> {
  const observation = options.observation ?? (await fetchCostcoProduct(product.code));
  const threshold = positiveInteger(env.FAILURE_ALERT_THRESHOLD, 3);
  const decision = decideNotification(product, observation, threshold);
  const persistedDecision = options.notify
    ? decision
    : { kind: "none" as const, reason: "notifications_suppressed" };

  await storeObservation(env.DB, product, observation, persistedDecision);

  console.info(
    JSON.stringify({
      event: "product_checked",
      productId: product.id,
      status: observation.status,
      stockLevel: observation.stockLevel,
      latencyMs: observation.latencyMs,
      decision: decision.kind,
      reason: observation.reason,
    }),
  );
  return observation;
}

async function flushPendingNotifications(env: AppEnv): Promise<void> {
  const pending = await listPendingNotifications(env.DB);
  for (const item of pending) {
    try {
      await sendDecisionNotification(
        env,
        item.payload.product,
        item.payload.observation,
        item.payload.decision,
      );
      await markNotificationDelivered(env.DB, item.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markNotificationFailed(env.DB, item.id, message);
      console.error(
        JSON.stringify({
          event: "notification_delivery_failed",
          notificationId: item.id,
          attempts: item.attempts + 1,
          error: message,
        }),
      );
    }
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
