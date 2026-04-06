-- migrate:up
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS grace_deadline TIMESTAMPTZ;

-- migrate:down
ALTER TABLE tenants DROP COLUMN IF EXISTS grace_deadline;
