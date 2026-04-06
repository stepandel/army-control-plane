import type { ControlPlaneEnv } from "@army/shared";
import { getDb } from "../db/client";
import { FlyClient } from "./fly";
import { syncBillingToKv } from "./billing-sync";

interface ExpiredRow {
  id: string;
  fly_app_name: string | null;
  fly_machine_id: string | null;
}

async function suspendOne(env: ControlPlaneEnv, tenant: ExpiredRow): Promise<void> {
  const sql = getDb(env);
  if (tenant.fly_app_name && tenant.fly_machine_id) {
    const fly = new FlyClient(env.FLY_API_TOKEN_VERA, tenant.fly_app_name);
    await fly.stopMachine(tenant.fly_machine_id);
  }
  await sql`
    UPDATE tenants
    SET subscription_status = 'suspended',
        status = 'suspended',
        grace_deadline = NULL,
        updated_at = now()
    WHERE id = ${tenant.id}
  `;
  await syncBillingToKv(env, tenant.id, "suspended", null, null);
}

/**
 * Suspend tenants whose trial expired or whose past_due grace period elapsed.
 * Called by the scheduled handler (cron).
 */
export async function enforceExpiredTrials(env: ControlPlaneEnv): Promise<{
  checked: number;
  suspended: number;
  errors: { tenantId: string; error: string }[];
}> {
  const sql = getDb(env);

  // Trials that have run out
  const expiredTrials = (await sql`
    SELECT id, fly_app_name, fly_machine_id
    FROM tenants
    WHERE subscription_status = 'trialing'
      AND trial_ends_at < now()
      AND status = 'active'
      AND fly_machine_id IS NOT NULL
  `) as ExpiredRow[];

  // past_due tenants whose 7-day grace period elapsed
  const expiredGrace = (await sql`
    SELECT id, fly_app_name, fly_machine_id
    FROM tenants
    WHERE subscription_status = 'past_due'
      AND grace_deadline IS NOT NULL
      AND grace_deadline < now()
      AND status = 'active'
      AND fly_machine_id IS NOT NULL
  `) as ExpiredRow[];

  const expired = [...expiredTrials, ...expiredGrace];

  const errors: { tenantId: string; error: string }[] = [];
  let suspended = 0;

  for (const tenant of expired) {
    try {
      await suspendOne(env, tenant);
      suspended++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to suspend tenant ${tenant.id}:`, message);
      errors.push({ tenantId: tenant.id, error: message });
    }
  }

  return { checked: expired.length, suspended, errors };
}
