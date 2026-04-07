import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";

type Sql = ReturnType<typeof getDb>;

const DEFAULT_YEARLY_PLAN_ENABLED = true;

/**
 * Read `system_settings.yearly_plan_enabled` and return as boolean.
 * Falls back to true (yearly plan visible) on missing or invalid values.
 *
 * To toggle off:
 *   INSERT INTO system_settings (key, value) VALUES ('yearly_plan_enabled', 'false')
 *   ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();
 */
export async function getYearlyPlanEnabled(
  envOrSql: ControlPlaneEnv | Sql,
): Promise<boolean> {
  try {
    const sql = isSqlClient(envOrSql) ? envOrSql : getDb(envOrSql);
    const [row] = await sql`
      SELECT value FROM system_settings WHERE key = 'yearly_plan_enabled'
    `;
    if (!row) return DEFAULT_YEARLY_PLAN_ENABLED;
    const value = (row as Record<string, string>).value.toLowerCase();
    return value === "true" || value === "1";
  } catch (err) {
    console.error("Failed to read yearly_plan_enabled, using fallback:", err);
    return DEFAULT_YEARLY_PLAN_ENABLED;
  }
}

function isSqlClient(value: ControlPlaneEnv | Sql): value is Sql {
  return typeof value === "function";
}
