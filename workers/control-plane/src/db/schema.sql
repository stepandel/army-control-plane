-- Army Control Plane — Neon Postgres schema

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,           -- e.g. Slack team_id "T012345"
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL,              -- "slack" | "linear" | "github"
  fly_app_name  TEXT,
  fly_machine_id TEXT,
  fly_volume_id TEXT,
  instance_url  TEXT,
  anthropic_api_key TEXT,                        -- optional BYOK Anthropic key (NULL = use global fallback)
  memory_mb     INTEGER,                     -- per-tenant memory override (NULL = default 1024)
  cpus          INTEGER,                     -- per-tenant CPU override (NULL = default 2)
  vera_production BOOLEAN NOT NULL DEFAULT true, -- VERA_PRODUCTION env var pushed to machine
  tracing_provider TEXT NOT NULL DEFAULT 'langfuse', -- 'langfuse' | 'langsmith' | 'none'
  stripe_customer_id TEXT,                       -- Stripe customer ID for billing
  stripe_subscription_id TEXT,                   -- Stripe subscription ID for active subscription
  subscription_status TEXT NOT NULL DEFAULT 'trialing', -- trialing | active | past_due | canceled | suspended
  trial_ends_at TIMESTAMPTZ,                     -- when the free trial expires (3 days from signup)
  grace_deadline TIMESTAMPTZ,                    -- end of grace period after subscription lapse
  cancel_at TIMESTAMPTZ,                         -- when a scheduled cancellation will take effect (cancel_at_period_end)
  current_period_end TIMESTAMPTZ,                -- end of the current billing period (next charge date)
  plan_interval TEXT,                            -- 'month' | 'year' — billing interval of the active plan
  plan_amount_cents INTEGER,                     -- recurring price of the active plan, in cents
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | provisioning | active | suspended
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_tokens (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,              -- "slack" | "linear" | "github"
  token_type  TEXT NOT NULL DEFAULT 'bot', -- bot | user
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  scopes      TEXT,
  external_id TEXT,                       -- platform-specific ID used for KV routing keys (e.g. Linear orgId, GitHub installationId)
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fly_machine_id TEXT NOT NULL,
  image_ref   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'deploying', -- deploying | running | stopped | failed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_tenant_platform ON integration_tokens(tenant_id, platform);
CREATE INDEX IF NOT EXISTS idx_tokens_tenant ON integration_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deployments_tenant ON deployments(tenant_id);

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email         TEXT,
  name          TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_identities (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  provider_user_id    TEXT NOT NULL,
  provider_email      TEXT,
  provider_name       TEXT,
  provider_avatar_url TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_identities_provider_subject
  ON account_identities(provider, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_account_identities_account
  ON account_identities(account_id);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slack_user_id   TEXT NOT NULL,
  slack_team_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           TEXT,
  name            TEXT,
  avatar_url      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slack ON users(slack_team_id, slack_user_id);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(slack_team_id);

CREATE INDEX IF NOT EXISTS idx_tenants_stripe_customer ON tenants(stripe_customer_id);

-- ── System settings ─────────────────────────────────────────────
-- Single-row-per-key store for runtime-tunable knobs (e.g. default_trial_days).
CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Promo codes ─────────────────────────────────────────────────
-- Catalog of redeemable codes. `code` is canonical UPPERCASE.
CREATE TABLE IF NOT EXISTS promo_codes (
  code            TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                     -- 'extend_trial' (only kind for now)
  extend_days     INTEGER NOT NULL,                  -- days added to trial from now()
  valid_until     TIMESTAMPTZ,                       -- optional expiry of the code itself
  max_redemptions INTEGER,                           -- optional global cap (NULL = unlimited)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-tenant redemption ledger — unique index enforces one redemption per (tenant, code).
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code        TEXT NOT NULL REFERENCES promo_codes(code),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemptions_tenant_code
  ON promo_redemptions(tenant_id, code);
