# Database Migrations

DB migrations for army-control-plane are managed with [dbmate](https://github.com/amacneil/dbmate) — a standalone, framework-agnostic migration tool that uses plain SQL files.

## Quick Reference

All commands run from `workers/control-plane/`:

```bash
# Set your Neon connection string (direct, not Hyperdrive)
export DATABASE_URL="postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/army?sslmode=require"

# Check which migrations have been applied / are pending
pnpm db:status

# Apply all pending migrations
pnpm db:migrate

# Roll back the most recent migration
pnpm db:rollback

# Create a new migration file
pnpm db:new <migration_name>
```

## How It Works

- **Migration files** live in `workers/control-plane/db/migrations/`
- Files are timestamped SQL files (e.g. `20260328000000_initial_schema.sql`)
- Each file has a `-- migrate:up` and `-- migrate:down` section
- dbmate tracks applied migrations in a `schema_migrations` table in your database
- Migrations run inside transactions (atomic) by default

## Creating a New Migration

```bash
cd workers/control-plane
pnpm db:new add_billing_columns
```

This creates a file like `db/migrations/20260328120000_add_billing_columns.sql` with the up/down template. Edit it:

```sql
-- migrate:up
ALTER TABLE tenants ADD COLUMN billing_plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT;

-- migrate:down
ALTER TABLE tenants DROP COLUMN IF EXISTS stripe_customer_id;
ALTER TABLE tenants DROP COLUMN IF EXISTS billing_plan;
```

### Guidelines

- **Always write both `up` and `down`** — rollbacks should cleanly undo the migration
- **Use `IF NOT EXISTS` / `IF EXISTS`** for safety where appropriate
- **One logical change per migration** — don't combine unrelated schema changes
- **Never edit an already-applied migration** — create a new one instead
- For operations that can't run in a transaction (e.g. `CREATE INDEX CONCURRENTLY`), add `-- migrate:options: transaction:false` after the `-- migrate:up` line

## Running Locally

1. Get the direct Neon connection string from the Neon dashboard (not the Hyperdrive pooler URL)
2. Set it as `DATABASE_URL`:
   ```bash
   export DATABASE_URL="postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/army?sslmode=require"
   ```
3. Run `pnpm db:migrate` from `workers/control-plane/`

> **Note:** Neon requires `sslmode=require` in the connection string. The Hyperdrive connection string used by Workers at runtime is different — it only works inside Cloudflare's network.

## CI Pipeline

Migrations are automated via GitHub Actions (`.github/workflows/migrate.yml`):

### Automatic (on merge to main)

When migration files in `workers/control-plane/db/migrations/` are changed and merged to main, the workflow automatically:
1. Shows current migration status
2. Applies pending migrations against the **production** Neon database
3. Reports results in the workflow summary

### Manual (workflow_dispatch)

You can manually trigger the workflow from the GitHub Actions tab:
- **Environment**: Choose `staging` or `production`
- **Dry run**: Check this to only show migration status without applying

### PR Check

When a PR includes changes to migration files, a status check runs `dbmate status` against the staging database and reports pending migrations in the PR check summary. This is informational only — it doesn't block the PR.

## Secrets Configuration

The workflow uses [GitHub Environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment) to scope secrets:

| Environment | Secret | Description |
|---|---|---|
| `staging` | `NEON_DATABASE_URL` | Direct Neon connection string for staging |
| `production` | `NEON_DATABASE_URL` | Direct Neon connection string for production |

Set these in **GitHub → Settings → Environments → [environment] → Environment secrets**.

The connection string format:
```
postgresql://<user>:<password>@<host>.neon.tech/<database>?sslmode=require
```

## Rollback

To roll back the most recent migration:

```bash
# Locally
cd workers/control-plane
export DATABASE_URL="..."
pnpm db:rollback

# Or via CI: trigger workflow_dispatch manually, then rollback locally if needed
```

dbmate rolls back one migration at a time using the `-- migrate:down` section. For multi-step rollbacks, run `pnpm db:rollback` repeatedly.

## First-Time Setup

When running against a database that already has the schema applied manually (before dbmate was introduced):

1. Apply migrations normally — the initial migration uses `CREATE TABLE IF NOT EXISTS` so it's safe to re-run
2. Alternatively, manually seed the tracking table to skip the initial migration:
   ```sql
   CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(128) NOT NULL PRIMARY KEY);
   INSERT INTO schema_migrations (version) VALUES ('20260328000000') ON CONFLICT DO NOTHING;
   ```
