import postgres from "postgres";
import type { ControlPlaneEnv } from "@army/shared";

/**
 * Create a Postgres client.
 * In production, uses Hyperdrive for connection pooling.
 * In local dev, falls back to DATABASE_URL from .dev.vars.
 */
export function getDb(env: ControlPlaneEnv) {
  const connectionString = env.DATABASE_URL ?? env.DB.connectionString;
  return postgres(connectionString, {
    prepare: false, // required for Hyperdrive
  });
}
