import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";

const DEFAULT_TRIAL_DAYS = 3;

type Sql = ReturnType<typeof getDb>;

/**
 * Read `system_settings.default_trial_days` and return it as a positive integer.
 * Falls back to DEFAULT_TRIAL_DAYS (3) on any error or invalid value so signup
 * never fails because of a missing/corrupt setting.
 *
 * Pass an existing `sql` client to reuse the connection; otherwise the function
 * will open one from `env`.
 */
export async function getDefaultTrialDays(envOrSql: ControlPlaneEnv | Sql): Promise<number> {
  try {
    const sql = isSqlClient(envOrSql) ? envOrSql : getDb(envOrSql);
    const [row] = await sql`
      SELECT value FROM system_settings WHERE key = 'default_trial_days'
    `;
    if (!row) return DEFAULT_TRIAL_DAYS;
    const n = parseInt((row as Record<string, string>).value, 10);
    if (Number.isInteger(n) && n > 0) return n;
    return DEFAULT_TRIAL_DAYS;
  } catch (err) {
    console.error("Failed to read default_trial_days, using fallback:", err);
    return DEFAULT_TRIAL_DAYS;
  }
}

function isSqlClient(value: ControlPlaneEnv | Sql): value is Sql {
  return typeof value === "function";
}
