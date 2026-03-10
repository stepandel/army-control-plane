import postgres from "postgres";
import type { ControlPlaneEnv } from "@army/shared";

/**
 * Create a Postgres client.
 * In production, uses Hyperdrive for connection pooling.
 * In local dev, wrangler uses CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB from .dev.vars.
 */
export function getDb(env: ControlPlaneEnv) {
  return postgres(env.DB.connectionString, {
    prepare: false, // required for Hyperdrive
  });
}
