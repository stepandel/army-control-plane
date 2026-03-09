import postgres from "postgres";
import type { ControlPlaneEnv } from "@army/shared";

/**
 * Create a Postgres client that goes through Hyperdrive.
 * Call this per-request — the underlying connection is pooled by Hyperdrive.
 */
export function getDb(env: ControlPlaneEnv) {
  return postgres(env.DB.connectionString, {
    prepare: false, // required for Hyperdrive
  });
}
