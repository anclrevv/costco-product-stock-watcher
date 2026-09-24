CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  check_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (check_interval_seconds >= 300),
  current_status TEXT NOT NULL DEFAULT 'unknown',
  last_confirmed_status TEXT,
  last_stock_level INTEGER,
  last_price REAL,
  currency TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  failure_notified_at TEXT,
  last_notified_status TEXT,
  last_notified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_checks (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  stock_level INTEGER,
  price REAL,
  currency TEXT,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  http_status INTEGER,
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_checks_product_time
  ON stock_checks(product_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS run_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
