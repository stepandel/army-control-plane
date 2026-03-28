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
  agentmail_api_key TEXT,                        -- optional per-tenant AgentMail key (NULL = skip)
  vera_production BOOLEAN NOT NULL DEFAULT true, -- VERA_PRODUCTION env var pushed to machine
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
