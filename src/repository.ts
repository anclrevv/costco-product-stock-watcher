import {
  canonicalProductUrl,
  isConfirmedStatus,
  productId,
  type ConfirmedStockStatus,
  type NotificationDecision,
  type NotificationPayload,
  type Product,
  type StockObservation,
  type StockStatus,
} from "./domain";
import type { AppEnv } from "./env";

interface ProductRow {
  id: string;
  code: string;
  name: string;
  url: string;
  enabled: number;
  check_interval_seconds: number;
  current_status: StockStatus;
  last_confirmed_status: ConfirmedStockStatus | null;
  last_stock_level: number | null;
  last_price: number | null;
  currency: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  failure_notified_at: string | null;
  last_notified_status: ConfirmedStockStatus | null;
  last_notified_at: string | null;
}

interface LegacyProduct {
  id?: unknown;
  code?: unknown;
  name?: unknown;
  url?: unknown;
  enabled?: unknown;
}

interface OutboxRow {
  id: string;
  payload_json: string;
  attempts: number;
}

export interface PendingNotification {
  id: string;
  payload: NotificationPayload;
  attempts: number;
}

export async function listProducts(db: D1Database, enabledOnly = false): Promise<Product[]> {
  const where = enabledOnly ? " WHERE enabled = 1" : "";
  const result = await db
    .prepare(`SELECT * FROM products${where} ORDER BY created_at ASC`)
    .all<ProductRow>();
  return result.results.map(mapProductRow);
}

export async function getProductByCode(db: D1Database, code: string): Promise<Product | null> {
  const row = await db
    .prepare("SELECT * FROM products WHERE code = ? LIMIT 1")
    .bind(code)
    .first<ProductRow>();
  return row ? mapProductRow(row) : null;
}

export async function countProducts(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM products").first<{ count: number }>();
  return row?.count ?? 0;
}

export async function upsertProduct(
  db: D1Database,
  input: { code: string; name: string; enabled?: boolean; checkIntervalSeconds?: number },
  now = new Date().toISOString(),
): Promise<Product> {
  const id = productId(input.code);
  const url = canonicalProductUrl(input.code);
  const enabled = input.enabled === false ? 0 : 1;
  const checkIntervalSeconds = Math.max(300, input.checkIntervalSeconds ?? 300);

  await db
    .prepare(
      `INSERT INTO products (
        id, code, name, url, enabled, check_interval_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        enabled = excluded.enabled,
        check_interval_seconds = excluded.check_interval_seconds,
        updated_at = excluded.updated_at`,
    )
    .bind(id, input.code, input.name, url, enabled, checkIntervalSeconds, now, now)
    .run();

  const product = await getProductByCode(db, input.code);
  if (!product) throw new Error(`Failed to save product ${input.code}`);
  return product;
}

export async function setProductEnabled(
  db: D1Database,
  code: string,
  enabled: boolean,
  now = new Date().toISOString(),
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE products SET enabled = ?, updated_at = ? WHERE code = ?")
    .bind(enabled ? 1 : 0, now, code)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function storeObservation(
  db: D1Database,
  product: Product,
  observation: StockObservation,
  decision: NotificationDecision,
): Promise<void> {
  const confirmed = isConfirmedStatus(observation.status);
  const failureCount = confirmed ? 0 : product.consecutiveFailures + 1;
  const failureNotifiedAt =
    decision.kind === "failure"
      ? observation.observedAt
      : decision.kind === "recovery"
        ? null
        : product.failureNotifiedAt;
  const lastNotifiedStatus =
    decision.kind === "restock" ? "in_stock" : product.lastNotifiedStatus;
  const lastNotifiedAt =
    decision.kind === "restock" ? observation.observedAt : product.lastNotifiedAt;
  const checkId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO stock_checks (
          id, product_id, observed_at, status, stock_level, price, currency,
          reason, evidence_json, latency_ms, http_status, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        checkId,
        product.id,
        observation.observedAt,
        observation.status,
        observation.stockLevel,
        observation.price,
        observation.currency,
        observation.reason,
        JSON.stringify(observation.evidence),
        observation.latencyMs,
        observation.httpStatus,
        observation.errorCode,
      ),
    db
      .prepare(
        `UPDATE products SET
          name = ?,
          current_status = ?,
          last_confirmed_status = ?,
          last_stock_level = ?,
          last_price = ?,
          currency = ?,
          last_checked_at = ?,
          last_success_at = ?,
          consecutive_failures = ?,
          failure_notified_at = ?,
          last_notified_status = ?,
          last_notified_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .bind(
        observation.name ?? product.name,
        observation.status,
        confirmed ? observation.status : product.lastConfirmedStatus,
        observation.stockLevel,
        observation.price,
        observation.currency,
        observation.observedAt,
        confirmed ? observation.observedAt : product.lastSuccessAt,
        failureCount,
        failureNotifiedAt,
        lastNotifiedStatus,
        lastNotifiedAt,
        observation.observedAt,
        product.id,
      ),
  ];

  if (decision.kind !== "none") {
    const payload: NotificationPayload = { product, observation, decision };
    statements.push(
      db
        .prepare(
          `INSERT INTO notification_outbox (
            id, product_id, kind, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          product.id,
          decision.kind,
          JSON.stringify(payload),
          observation.observedAt,
        ),
    );
  }

  await db.batch(statements);
}

export async function listPendingNotifications(
  db: D1Database,
  limit = 20,
): Promise<PendingNotification[]> {
  const rows = await db
    .prepare(
      `SELECT id, payload_json, attempts
       FROM notification_outbox
       WHERE delivered_at IS NULL
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(Math.max(1, Math.min(limit, 100)))
    .all<OutboxRow>();

  return rows.results.map((row) => ({
    id: row.id,
    payload: JSON.parse(row.payload_json) as NotificationPayload,
    attempts: row.attempts,
  }));
}

export async function markNotificationDelivered(
  db: D1Database,
  id: string,
  deliveredAt = new Date().toISOString(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_outbox
       SET delivered_at = ?, attempts = attempts + 1, last_error = NULL
       WHERE id = ?`,
    )
    .bind(deliveredAt, id)
    .run();
}

export async function markNotificationFailed(
  db: D1Database,
  id: string,
  error: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE notification_outbox
       SET attempts = attempts + 1, last_error = ?
       WHERE id = ?`,
    )
    .bind(error.slice(0, 500), id)
    .run();
}

export async function acquireRunLock(
  db: D1Database,
  name: string,
  owner: string,
  now = new Date(),
  ttlSeconds = 240,
): Promise<boolean> {
  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000).toISOString();
  await db
    .prepare(
      `INSERT INTO run_locks (name, owner, acquired_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         owner = excluded.owner,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at
       WHERE run_locks.expires_at < excluded.acquired_at`,
    )
    .bind(name, owner, acquiredAt, expiresAt)
    .run();

  const row = await db
    .prepare("SELECT owner FROM run_locks WHERE name = ?")
    .bind(name)
    .first<{ owner: string }>();
  return row?.owner === owner;
}

export async function releaseRunLock(db: D1Database, name: string, owner: string): Promise<void> {
  await db.prepare("DELETE FROM run_locks WHERE name = ? AND owner = ?").bind(name, owner).run();
}

export async function importLegacyProducts(env: AppEnv): Promise<number> {
  if ((await countProducts(env.DB)) > 0) return 0;

  const legacy = await env.COSTCO_KV.get<LegacyProduct[]>("products", "json");
  if (!Array.isArray(legacy)) return 0;

  let imported = 0;
  for (const item of legacy) {
    const code = extractLegacyCode(item);
    if (!code) continue;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `Costco 商品 ${code}`;
    await upsertProduct(env.DB, {
      code,
      name,
      enabled: item.enabled !== false,
    });
    imported += 1;
  }

  if (imported > 0) {
    const now = new Date().toISOString();
    await env.DB
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES ('legacy_kv_import', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify({ imported }), now)
      .run();
  }

  return imported;
}

function extractLegacyCode(item: LegacyProduct): string | null {
  if (typeof item.code === "string" && /^[A-Za-z0-9-]{4,32}$/.test(item.code)) return item.code;
  if (typeof item.id === "string") {
    const idMatch = item.id.match(/^costco-([A-Za-z0-9-]{4,32})$/i);
    if (idMatch?.[1]) return idMatch[1];
  }
  if (typeof item.url === "string") {
    const urlMatch = item.url.match(/\/p\/([A-Za-z0-9-]{4,32})(?:\/|$)/i);
    if (urlMatch?.[1]) return urlMatch[1];
  }
  return null;
}

function mapProductRow(row: ProductRow): Product {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    url: row.url,
    enabled: row.enabled === 1,
    checkIntervalSeconds: row.check_interval_seconds,
    currentStatus: row.current_status,
    lastConfirmedStatus: row.last_confirmed_status,
    lastStockLevel: row.last_stock_level,
    lastPrice: row.last_price,
    currency: row.currency,
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    consecutiveFailures: row.consecutive_failures,
    failureNotifiedAt: row.failure_notified_at,
    lastNotifiedStatus: row.last_notified_status,
    lastNotifiedAt: row.last_notified_at,
  };
}
