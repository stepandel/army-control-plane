-- migrate:up

-- 1. Single-row-per-key system settings — lets us tune the default trial length from the DB
CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value) VALUES ('default_trial_days', '3')
  ON CONFLICT (key) DO NOTHING;

-- 2. Promo code catalog
CREATE TABLE IF NOT EXISTS promo_codes (
  code            TEXT PRIMARY KEY,                  -- canonical UPPERCASE
  kind            TEXT NOT NULL,                     -- 'extend_trial' (only kind for now)
  extend_days     INTEGER NOT NULL,                  -- days added to trial from now()
  valid_until     TIMESTAMPTZ,                       -- optional expiry of the code itself
  max_redemptions INTEGER,                           -- optional global cap (NULL = unlimited)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO promo_codes (code, kind, extend_days) VALUES ('FRIEND2026', 'extend_trial', 30)
  ON CONFLICT (code) DO NOTHING;

-- 3. Per-tenant redemption ledger — also enforces "one redemption per code per tenant"
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code        TEXT NOT NULL REFERENCES promo_codes(code),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemptions_tenant_code
  ON promo_redemptions(tenant_id, code);

-- migrate:down
DROP INDEX IF EXISTS idx_promo_redemptions_tenant_code;
DROP TABLE IF EXISTS promo_redemptions;
DROP TABLE IF EXISTS promo_codes;
DROP TABLE IF EXISTS system_settings;
