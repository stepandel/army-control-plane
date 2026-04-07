-- migrate:up
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_interval TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_amount_cents INTEGER;

-- migrate:down
ALTER TABLE tenants DROP COLUMN IF EXISTS plan_amount_cents;
ALTER TABLE tenants DROP COLUMN IF EXISTS plan_interval;
