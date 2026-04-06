-- migrate:up
ALTER TABLE tenants ADD COLUMN tracing_provider TEXT NOT NULL DEFAULT 'langfuse';
ALTER TABLE tenants DROP COLUMN IF EXISTS telemetry_enabled;

-- migrate:down
ALTER TABLE tenants ADD COLUMN telemetry_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE tenants DROP COLUMN IF EXISTS tracing_provider;
