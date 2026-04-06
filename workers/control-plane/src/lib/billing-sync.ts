import type { ControlPlaneEnv, TenantRoute } from "@army/shared";
import { getDb } from "../db/client";

/**
 * Update billing fields on all KV route entries for a tenant.
 * Preserves instance_url, internal_secret, and fly_machine_id.
 *
 * Pass `null` for trial_ends_at / grace_deadline to clear them in KV.
 * Pass `undefined` to leave them unchanged.
 *
 * Called whenever a subscription state transition happens, so the router
 * can gate webhook forwarding without hitting the DB.
 */
export async function syncBillingToKv(
  env: ControlPlaneEnv,
  tenantId: string,
  subscriptionStatus: string,
  trialEndsAt?: string | null,
  graceDeadline?: string | null,
): Promise<void> {
  const sql = getDb(env);

  const tokens = await sql`
    SELECT DISTINCT platform, external_id
    FROM integration_tokens
    WHERE tenant_id = ${tenantId} AND external_id IS NOT NULL
  `;

  for (const row of tokens) {
    const platform = (row as Record<string, string>).platform;
    const externalId = (row as Record<string, string>).external_id;
    const key = `${platform}:${externalId}`;

    const existing = await env.ROUTING_TABLE.get<TenantRoute>(key, "json");
    if (!existing) continue;

    const updated: TenantRoute = {
      instance_url: existing.instance_url,
      internal_secret: existing.internal_secret,
      ...(existing.fly_machine_id !== undefined && { fly_machine_id: existing.fly_machine_id }),
      subscription_status: subscriptionStatus,
    };

    // trial_ends_at: undefined = leave as-is, null = clear, string = set
    if (trialEndsAt === null) {
      // omit (clears)
    } else if (trialEndsAt !== undefined) {
      updated.trial_ends_at = trialEndsAt;
    } else if (existing.trial_ends_at !== undefined) {
      updated.trial_ends_at = existing.trial_ends_at;
    }

    // grace_deadline: same logic
    if (graceDeadline === null) {
      // omit
    } else if (graceDeadline !== undefined) {
      updated.grace_deadline = graceDeadline;
    } else if (existing.grace_deadline !== undefined) {
      updated.grace_deadline = existing.grace_deadline;
    }

    await env.ROUTING_TABLE.put(key, JSON.stringify(updated));
  }
}
