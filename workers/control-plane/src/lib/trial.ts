import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "./fly";

/**
 * Find tenants whose trial has expired without subscribing, and suspend them.
 * Called by the scheduled handler (cron).
 */
export async function enforceExpiredTrials(env: ControlPlaneEnv): Promise<{
  checked: number;
  suspended: number;
  errors: { tenantId: string; error: string }[];
}> {
  const sql = getDb(env);

  // Find tenants still trialing whose trial has expired and machine is still active
  const expired = await sql`
    SELECT id, fly_app_name, fly_machine_id
    FROM tenants
    WHERE subscription_status = 'trialing'
      AND trial_ends_at < now()
      AND status = 'active'
      AND fly_machine_id IS NOT NULL
  `;

  const errors: { tenantId: string; error: string }[] = [];
  let suspended = 0;

  for (const tenant of expired) {
    try {
      // Stop the Fly machine
      if (tenant.fly_app_name && tenant.fly_machine_id) {
        const fly = new FlyClient(env.FLY_API_TOKEN_VERA, tenant.fly_app_name);
        await fly.stopMachine(tenant.fly_machine_id);
      }

      // Update tenant status
      await sql`
        UPDATE tenants
        SET subscription_status = 'suspended',
            status = 'suspended',
            updated_at = now()
        WHERE id = ${tenant.id}
      `;

      suspended++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to suspend expired trial tenant ${tenant.id}:`, message);
      errors.push({ tenantId: tenant.id, error: message });
    }
  }

  return { checked: expired.length, suspended, errors };
}
