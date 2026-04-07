-- migrate:up
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ;

-- migrate:down
ALTER TABLE tenants DROP COLUMN IF EXISTS cancel_at;
