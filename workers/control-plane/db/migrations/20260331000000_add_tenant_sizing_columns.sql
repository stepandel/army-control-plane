-- migrate:up
ALTER TABLE tenants ADD COLUMN memory_mb INTEGER;
ALTER TABLE tenants ADD COLUMN cpus INTEGER;

-- migrate:down
ALTER TABLE tenants DROP COLUMN IF EXISTS cpus;
ALTER TABLE tenants DROP COLUMN IF EXISTS memory_mb;
