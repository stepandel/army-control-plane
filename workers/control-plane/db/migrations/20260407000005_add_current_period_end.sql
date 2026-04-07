-- migrate:up
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

-- migrate:down
ALTER TABLE tenants DROP COLUMN IF EXISTS current_period_end;
